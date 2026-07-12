/**
 * @fileoverview Serviço de Autenticação do SETUR Forms GAS.
 * Gerencia login, sessões via CacheService e rate limiting.
 */

// ============================================================
// AUTENTICAÇÃO
// ============================================================

/**
 * Autentica o administrador com senha + proteção de rate limiting.
 * @param {string} senha - Senha em texto claro (hasheada aqui)
 * @param {string} fingerprint - Identificador do cliente (IP+UA hash)
 * @returns {{ok: boolean, token?: string, error?: string, aguardar?: number}}
 */
function autenticar(senha, fingerprint) {
  try {
    // 1. Verificar rate limiting
    const limitStatus = verificarRateLimit_(fingerprint);
    if (limitStatus.bloqueado) {
      logEvento('SYSTEM', NIVEL_LOG.WARN,
        'Tentativa de login bloqueada por rate limiting. Fingerprint: ' + fingerprint.substring(0, 8));
      return respostaErro(
        'Muitas tentativas. Aguarde ' + limitStatus.aguardarSegundos + ' segundos.',
        'RATE_LIMIT'
      );
    }

    // 2. Obter hash armazenado
    const config = obterConfig();
    const hashArmazenado = config['senhaHash'];

    if (!hashArmazenado) {
      return respostaErro('Sistema não configurado. Defina a senha do administrador.', 'SEM_SENHA');
    }

    // 3. Verificar senha
    const hashDigitado = hashSHA256(senha);
    if (hashDigitado !== hashArmazenado) {
      incrementarTentativas_(fingerprint);
      const restantes = LIMITE.RATE_LIMIT_TENTATIVAS - (limitStatus.tentativas + 1);
      logEvento('SYSTEM', NIVEL_LOG.WARN, 'Tentativa de login com senha incorreta.');
      return respostaErro(
        'Senha incorreta. ' + (restantes > 0 ? restantes + ' tentativas restantes.' : 'Conta bloqueada temporariamente.'),
        'SENHA_INCORRETA'
      );
    }

    // 4. Login bem-sucedido — limpar tentativas e criar sessão
    limparTentativas_(fingerprint);
    const token = criarSessao_();

    logEvento('SYSTEM', NIVEL_LOG.INFO, 'Login admin realizado com sucesso.');
    return respostaOk({ token: token });

  } catch (e) {
    logEvento('SYSTEM', NIVEL_LOG.ERROR, 'Erro na autenticação: ' + e.message, e.stack);
    return respostaErro('Erro interno na autenticação.', 'ERRO_AUTH');
  }
}

/**
 * Valida se um token de sessão é válido e renova o TTL.
 * @param {string} token - Token de sessão
 * @returns {boolean}
 */
function validarSessao(token) {
  if (!token) return false;
  try {
    const cache = CacheService.getScriptCache();
    const dados = cache.get('sessao_' + token);
    if (!dados) return false;

    // Renovar TTL automaticamente (sliding window)
    cache.put('sessao_' + token, dados, LIMITE.CACHE_SESSAO_SEGUNDOS);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Encerra a sessão de um token.
 * @param {string} token
 */
function logout(token) {
  if (!token) return;
  try {
    CacheService.getScriptCache().remove('sessao_' + token);
    logEvento('SYSTEM', NIVEL_LOG.INFO, 'Logout realizado.');
  } catch (e) {
    // Silencioso
  }
}

/**
 * Define ou atualiza a senha do administrador.
 * Armazena apenas o hash SHA-256.
 * @param {string} senhaAtual - Senha atual (para confirmação)
 * @param {string} novaSenha - Nova senha em texto claro
 * @returns {{ok: boolean, error?: string}}
 */
function alterarSenha(senhaAtual, novaSenha) {
  try {
    const config = obterConfig();
    const hashAtual = config['senhaHash'];

    // Se já há senha configurada, exigir a atual
    if (hashAtual && hashSHA256(senhaAtual) !== hashAtual) {
      return respostaErro('Senha atual incorreta.', 'SENHA_INCORRETA');
    }

    if (!novaSenha || novaSenha.length < 8) {
      return respostaErro('A senha deve ter pelo menos 8 caracteres.', 'SENHA_FRACA');
    }

    definirConfig('senhaHash', hashSHA256(novaSenha));
    logEvento('SYSTEM', NIVEL_LOG.INFO, 'Senha do administrador alterada.');
    return respostaOk({ mensagem: 'Senha alterada com sucesso.' });
  } catch (e) {
    logEvento('SYSTEM', NIVEL_LOG.ERROR, 'Erro ao alterar senha: ' + e.message, e.stack);
    return respostaErro('Erro ao alterar senha.', 'ERRO_SENHA');
  }
}

// ============================================================
// FUNÇÕES INTERNAS DE SESSÃO
// ============================================================

/**
 * Cria uma nova sessão e armazena no CacheService.
 * @returns {string} Token de sessão (UUID)
 * @private
 */
function criarSessao_() {
  const token = gerarUUID();
  const dados = JSON.stringify({
    criadoEm: new Date().toISOString(),
    tipo: 'admin',
  });
  CacheService.getScriptCache().put(
    'sessao_' + token,
    dados,
    LIMITE.CACHE_SESSAO_SEGUNDOS
  );
  return token;
}

// ============================================================
// RATE LIMITING
// ============================================================

/**
 * Verifica o status de rate limiting para um fingerprint.
 * @param {string} fingerprint
 * @returns {{bloqueado: boolean, tentativas: number, aguardarSegundos: number}}
 * @private
 */
function verificarRateLimit_(fingerprint) {
  const cache = CacheService.getScriptCache();
  const chave = 'rl_' + hashSHA256(fingerprint).substring(0, 16);
  const dados = cache.get(chave);

  if (!dados) {
    return { bloqueado: false, tentativas: 0, aguardarSegundos: 0 };
  }

  const info = JSON.parse(dados);
  const config = obterConfig();
  const maxTentativas = parseInt(config['rateLimitMax']) || LIMITE.RATE_LIMIT_TENTATIVAS;

  if (info.tentativas >= maxTentativas) {
    const agora = Date.now();
    const expiracaoMs = info.inicioMs + (parseInt(config['rateLimitJanela']) || LIMITE.RATE_LIMIT_JANELA_S) * 1000;
    const aguardar = Math.ceil((expiracaoMs - agora) / 1000);
    return { bloqueado: aguardar > 0, tentativas: info.tentativas, aguardarSegundos: Math.max(0, aguardar) };
  }

  return { bloqueado: false, tentativas: info.tentativas, aguardarSegundos: 0 };
}

/**
 * Incrementa o contador de tentativas de login para um fingerprint.
 * @param {string} fingerprint
 * @private
 */
function incrementarTentativas_(fingerprint) {
  const cache = CacheService.getScriptCache();
  const chave = 'rl_' + hashSHA256(fingerprint).substring(0, 16);
  const dados = cache.get(chave);
  const config = obterConfig();
  const janela = parseInt(config['rateLimitJanela']) || LIMITE.RATE_LIMIT_JANELA_S;

  let info = dados ? JSON.parse(dados) : { tentativas: 0, inicioMs: Date.now() };
  info.tentativas++;

  cache.put(chave, JSON.stringify(info), janela);
}

/**
 * Limpa o contador de tentativas após login bem-sucedido.
 * @param {string} fingerprint
 * @private
 */
function limparTentativas_(fingerprint) {
  const chave = 'rl_' + hashSHA256(fingerprint).substring(0, 16);
  CacheService.getScriptCache().remove(chave);
}
