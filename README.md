# SETUR Forms GAS

Uma plataforma completa, robusta e modular de formulários dinâmicos integrada nativamente ao ecossistema do Google Workspace (Google Apps Script, Google Sheets e Google Drive).

## 🚀 Funcionalidades Principais

*   **Painel Administrativo (`/admin`):** Construtor visual de formulários de arrastar e soltar (drag & drop), editor de propriedades do formulário (tema, prazo, limite de respostas, link para editais/regulamento, versão), gerenciamento de seções e perguntas.
*   **Editor Rich Text (WYSIWYG):** Editor integrado na descrição do formulário e nas perguntas, suportando negrito, itálico, sublinhado, tachado, alinhamento, listas ordenadas/não ordenadas, links e remoção de formatação.
*   **Dashboard de Resultados (`/dash`):** Painel interativo com métricas de envios em tempo real (total de respostas, taxa de conclusão, recebidas hoje), gráficos de linha e setores, exportação em lote de fichas de inscrição em formato PDF e exportação de dados em formato CSV.
*   **Gerenciamento Dinâmico de Prazo:** Banner informativo de encerramento programado com contagem regressiva ativada automaticamente nas últimas horas de encerramento do formulário.
*   **Validação Avançada de Arquivos:** Suporte a upload de arquivos parametrizado por extensão de arquivo permitida (Imagens, PDF, Word, Excel, PowerPoint, Texto ou customizadas) e limite de tamanho individual (MB) com validação rígida no client-side e no server-side (Drive API).
*   **Estrutura de Pastas Organizada:** Armazenamento automático e isolado no Google Drive, separando os anexos em pastas nomeadas de acordo com a respectiva pergunta de upload.
*   **Contingência e Reconciliação:** Mecanismo robusto contra falhas de conexão ou timeouts do Apps Script (LockService), salvando intenções e processando automaticamente envios em segundo plano por meio de fila temporária (`FILA`).
*   **Preenchimento com Rascunho Automático:** Salvamento automático local (Local Storage) do progresso do preenchimento com exclusão limpa e segura de arquivos anexados temporariamente no Drive caso o rascunho seja descartado.
*   **LGPD & Termos de Uso:** Tipo de pergunta especializada para "Aceite de Termos" que atua de forma estritamente obrigatória no lado do cliente e do servidor.

---

## 🛠️ Arquitetura e Estrutura Técnica

O projeto é modularizado de forma a separar a interface web (HTML/CSS/JS) da lógica de backend em Apps Script (GS).

```
SETUR Forms/
├── .agents/               # Pasta de regras e memória da IA (Ignorada pelo Git)
├── .clasp.json            # Configuração do Clasp para deploy
├── INSTALACAO.md          # Guia passo a passo de setup manual
├── README.md              # Documentação unificada do projeto
└── src/                   # Código fonte principal
    ├── appsscript.json    # Manifesto do Apps Script
    ├── Code.gs            # Ponto de entrada (doGet)
    ├── Api.gs             # Roteador de chamadas de API (Admin e Públicas)
    ├── AuthService.gs     # Controle de sessões e autenticação do Admin
    ├── FormService.gs     # CRUD e controle de publicação (Rascunho vs Publicado)
    ├── ResponseService.gs # Gravação de respostas e revalidação de dados
    ├── DashService.gs     # Agregação de dados para o Dashboard
    ├── DriveService.gs    # Gerenciamento de pastas, uploads e fichas de inscrição
    ├── FichaService.gs    # Conversão de respostas individuais em fichas PDF
    ├── Utils.gs           # Utilitários globais (UUID, parser de Navegador, criptografia)
    ├── Setup.gs           # Script de migração de colunas e criação de estrutura
    ├── Triggers.gs        # Gatilhos automáticos para processamento em background
    ├── index.html         # Template do invólucro principal do SPA
    ├── admin.html         # Interface do construtor de formulários (Admin)
    ├── form.html          # Renderizador do formulário público
    ├── dash.html          # Visualizador de resultados e métricas (Dashboard)
    ├── css.html           # Estilização global e tokens visuais
    ├── js-utils.html      # Helpers JavaScript (Sessão, Rascunhos, Toast, Loading)
    └── js-validators.html # Validadores de dados no client (CPF, CNPJ, Email, CEP, etc.)
```

### Regras de Negócio e Convenções Técnicas
*   **Versionamento do Formulário:** Gravado dinamicamente no cabeçalho das respostas com base na versão definida pelo administrador no painel de propriedades.
*   **Auditoria de Acesso:** O campo "Navegador" decodifica a string técnica do *User-Agent* em tempo de inserção, gravando no histórico o formato inteligível (exemplo: `Chrome 149 · Windows 10/11`).
*   **IP de Origem:** Capturado assincronamente no carregamento do formulário e verificado com tempo de espera limite no envio para evitar vazios no banco de dados.

---

## 💻 Desenvolvimento Local e Deploy

O projeto está configurado para utilizar o [Google Clasp](https://github.com/google/clasp).

### Comandos Úteis
*   **Enviar alterações para o Apps Script:**
    ```bash
    clasp push --force
    ```
*   **Re-implantar Web App em Produção:**
    ```bash
    clasp deploy -i <DEPLOYMENT_ID> -d "Descrição das melhorias"
    ```

---

## 📄 Licença e Uso

Este software é fornecido conforme as regras internas de desenvolvimento da Secretaria de Turismo (SETUR).
Para instruções completas sobre inicialização e criação da estrutura de banco de dados no Google Sheets, consulte o Guia de Instalação (INSTALACAO.md).
