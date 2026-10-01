/**
 * Setup automatizado do formulário do Festival Italiano de São Sebastião 2026.
 * Executar esta função no painel do Google Apps Script irá injetar o formulário completo
 * no sistema SETUR Forms.
 */
function instalarFormularioFestivalItaliano() {
  const formConfig = {
    titulo: 'Festival Italiano de São Sebastião 2026',
    descricao: 'Inscrição para Concessão Onerosa de Estandes e Espaços. De 01 a 19 de outubro de 2026.',
    configJSON: {
      configuracoes: {
        agruparUploadsPor: 'RESPOSTA', 
        campoNomePasta: 'nome_fantasia', // O nome da pasta será o nome fantasia
        mensagemConfirmacao: '<h3>Inscrição Recebida!</h3><p>Sua inscrição para o Festival Italiano de São Sebastião 2026 foi registrada com sucesso.</p>'
      },
      logicaCondicional: [
        { acao: 'OCULTAR_PERGUNTA', destino: 'ata_eleicao', perguntaOrigem: 'categoria', operador: 'DIFERENTE', valor: 'Instituições assistenciais' },
        { acao: 'OCULTAR_PERGUNTA', destino: 'estatuto', perguntaOrigem: 'categoria', operador: 'DIFERENTE', valor: 'Instituições assistenciais' },
        { acao: 'OCULTAR_PERGUNTA', destino: 'comprovante_cnpj', perguntaOrigem: 'categoria', operador: 'DIFERENTE', valor: 'Instituições assistenciais' },
        
        { acao: 'OCULTAR_PERGUNTA', destino: 'comprovante_atuacao', perguntaOrigem: 'categoria', operador: 'DIFERENTE', valor: 'Instituições comerciais' },
        
        { acao: 'OCULTAR_PERGUNTA', destino: 'licenca_ambulante', perguntaOrigem: 'categoria', operador: 'DIFERENTE', valor: 'Ambulantes' },
        { acao: 'OCULTAR_PERGUNTA', destino: 'cnpj_ambulante', perguntaOrigem: 'categoria', operador: 'DIFERENTE', valor: 'Ambulantes' }
      ],
      secoes: [
        {
          titulo: 'Dados Gerais do Participante',
          perguntas: [
            { id: 'categoria', titulo: 'Categoria de Inscrição', tipo: 'MULTIPLA_ESCOLHA', obrigatoria: true, opcoes: ['Instituições assistenciais', 'Instituições comerciais', 'Ambulantes'] },
            { id: 'nome_estande', titulo: 'Nome pretendido para o Estande', tipo: 'RESPOSTA_CURTA', obrigatoria: true },
            { id: 'nome_fantasia', titulo: 'Nome fantasia do estabelecimento', tipo: 'RESPOSTA_CURTA', obrigatoria: true },
            { id: 'nome_resp', titulo: 'Nome do responsável', tipo: 'RESPOSTA_CURTA', obrigatoria: true },
            { id: 'telefone_resp', titulo: 'Telefone do responsável', tipo: 'RESPOSTA_CURTA', obrigatoria: true, validacao: { tipo: 'TELEFONE' } },
            { id: 'endereco', titulo: 'Endereço do estabelecimento', tipo: 'RESPOSTA_CURTA', obrigatoria: true },
            { id: 'telefone_est', titulo: 'Telefone do estabelecimento', tipo: 'RESPOSTA_CURTA', obrigatoria: true, validacao: { tipo: 'TELEFONE' } },
            { id: 'historico', titulo: 'Breve histórico do estabelecimento', tipo: 'PARAGRAFO', obrigatoria: true }
          ]
        },
        {
          titulo: 'Documentação Comum (Obrigatória)',
          perguntas: [
            { id: 'lista_pratos', titulo: 'Lista de pratos a comercializar (PDF)', tipo: 'UPLOAD_ARQUIVO', obrigatoria: true, config: { tamanhoMaxMB: 5, extensoesPermitidas: ['pdf'] } },
            { id: 'declaracao_negativa', titulo: 'Declaração Negativa de Fato Impeditivo (PDF)', tipo: 'UPLOAD_ARQUIVO', obrigatoria: true, config: { tamanhoMaxMB: 5, extensoesPermitidas: ['pdf'] } },
            { id: 'espelho_cnpj', titulo: 'Espelho do CNPJ (PDF)', tipo: 'UPLOAD_ARQUIVO', obrigatoria: true, config: { tamanhoMaxMB: 5, extensoesPermitidas: ['pdf'] } },
            { id: 'contrato_social', titulo: 'Contrato Social ou CCMEI (PDF)', tipo: 'UPLOAD_ARQUIVO', obrigatoria: true, config: { tamanhoMaxMB: 5, extensoesPermitidas: ['pdf'] } }
          ]
        },
        {
          titulo: 'Documentação Específica (por Categoria)',
          perguntas: [
            // Assistenciais
            { id: 'ata_eleicao', titulo: 'Última Ata de eleição registrada em cartório', tipo: 'UPLOAD_ARQUIVO', config: { tamanhoMaxMB: 5, extensoesPermitidas: ['pdf'] } },
            { id: 'estatuto', titulo: 'Estatuto da instituição', tipo: 'UPLOAD_ARQUIVO', config: { tamanhoMaxMB: 5, extensoesPermitidas: ['pdf'] } },
            { id: 'comprovante_cnpj', titulo: 'Comprovante de Inscrição Ativa no CNPJ', tipo: 'UPLOAD_ARQUIVO', config: { tamanhoMaxMB: 5, extensoesPermitidas: ['pdf'] } },
            
            // Comerciais
            { id: 'comprovante_atuacao', titulo: 'Comprovação de atuação no setor de alimentos', tipo: 'UPLOAD_ARQUIVO', config: { tamanhoMaxMB: 5, extensoesPermitidas: ['pdf'] } },
            
            // Ambulantes
            { id: 'licenca_ambulante', titulo: 'Licença de atuação na região central de São Sebastião', tipo: 'UPLOAD_ARQUIVO', config: { tamanhoMaxMB: 5, extensoesPermitidas: ['pdf'] } },
            { id: 'cnpj_ambulante', titulo: 'CNPJ (se aplicável para ambulante)', tipo: 'UPLOAD_ARQUIVO', config: { tamanhoMaxMB: 5, extensoesPermitidas: ['pdf'] } },
            
            // Comum para representantes (assistencial/ambulante)
            { id: 'rg_cpf', titulo: 'Cópia do RG e CPF do representante legal/ambulante', tipo: 'UPLOAD_ARQUIVO', obrigatoria: true, config: { tamanhoMaxMB: 5, extensoesPermitidas: ['pdf', 'jpg', 'png'] } },
            { id: 'comprovante_residencia', titulo: 'Comprovante de residência válido', tipo: 'UPLOAD_ARQUIVO', obrigatoria: true, config: { tamanhoMaxMB: 5, extensoesPermitidas: ['pdf', 'jpg', 'png'] } }
          ]
        }
      ]
    }
  };

  const resposta = criarFormulario(formConfig);
  if (resposta.ok) {
    Logger.log('✅ Formulário do Festival Italiano criado com sucesso!');
    Logger.log('🔗 Link Público: ' + resposta.data.urlFormulario);
    Logger.log('⚙️ Link Dashboard Admin: ' + resposta.data.urlDashboard);
  } else {
    Logger.log('❌ Erro ao criar o formulário: ' + resposta.error);
  }
}
