# Guia de Instalação — SETUR Forms GAS

Este guia explica detalhadamente como implantar a plataforma **SETUR Forms GAS** na sua conta do Google Drive e Google Sheets. Siga cada passo com atenção.

---

## Passo 1: Criar a Planilha Mestre

1. Acesse o [Google Sheets](https://sheets.google.com) e crie uma **Nova Planilha em branco**.
2. Dê a ela o nome de **`SETUR Forms - Planilha Mestre`** (ou qualquer nome de sua preferência).
3. Copie o **ID da Planilha** a partir da URL.
   * *Exemplo de URL:* `https://docs.google.com/spreadsheets/d/1A2B3C4D5E6F7G8H9I0J/edit#gid=0`
   * *O ID é o trecho entre `/d/` e `/edit`:* `1A2B3C4D5E6F7G8H9I0J`
   * **Guarde este ID**, você precisará dele no Passo 3.

---

## Passo 2: Acessar o Editor do Google Apps Script

1. Na sua Planilha Mestre, clique no menu superior em **Extensões** > **Apps Script**.
2. O editor de código do Google Apps Script será aberto em uma nova aba.
3. Altere o nome do projeto (canto superior esquerdo) de `Projeto sem título` para **`SETUR Forms`**.

---

## Passo 3: Criar os Arquivos de Código

No painel lateral esquerdo do Apps Script, você precisará criar os arquivos correspondentes aos arquivos locais da pasta `src/`.

### Arquivos de Script (.gs)
Para cada arquivo `.gs` listado abaixo, clique no botão **`+` (Adicionar um arquivo)** > **Script**, dê o nome exato (sem o `.gs`) e cole o conteúdo do respectivo arquivo:
1. `Code` (conteúdo de `src/Code.gs`)
2. `Api` (conteúdo de `src/Api.gs`)
3. `AuthService` (conteúdo de `src/AuthService.gs`)
4. `FormService` (conteúdo de `src/FormService.gs`)
5. `ResponseService` (conteúdo de `src/ResponseService.gs`)
6. `DashService` (conteúdo de `src/DashService.gs`)
7. `DriveService` (conteúdo de `src/DriveService.gs`)
8. `Utils` (conteúdo de `src/Utils.gs`)
9. `Setup` (conteúdo de `src/Setup.gs`)
10. `Triggers` (conteúdo de `src/Triggers.gs`)

### Arquivos HTML (.html)
Para cada arquivo `.html` listado abaixo, clique no botão **`+` (Adicionar um arquivo)** > **HTML**, dê o nome exato (sem o `.html`) e cole o conteúdo do respectivo arquivo:
1. `admin` (conteúdo de `src/admin.html`)
2. `form` (conteúdo de `src/form.html`)
3. `dash` (conteúdo de `src/dash.html`)
4. `index` (conteúdo de `src/index.html`)
5. `css` (conteúdo de `src/css.html`)
6. `js-utils` (conteúdo de `src/js-utils.html`)
7. `js-validators` (conteúdo de `src/js-validators.html`)

*Dica: Salve o projeto periodicamente usando o atalho `Ctrl + S`.*

---

## Passo 4: Executar a Inicialização (Setup)

1. No editor de código, abra o arquivo `Setup.gs`.
2. No menu superior de seleção de funções, selecione a função **`setup`**.
3. Clique em **Executar**.
4. **Autorização Obrigatória:** O Google solicitará permissões para acessar sua planilha, e-mail e arquivos do Drive.
   * Clique em *Revisar permissões*.
   * Escolha sua conta do Google.
   * Clique em *Avançado* (canto inferior esquerdo da janela de aviso) e depois em *Acessar SETUR Forms (não seguro)*.
   * Clique em *Permitir*.
5. Aguarde a execução terminar. No console de execução você deverá ver mensagens indicando que a estrutura foi criada.

Se você verificar sua Planilha Mestre, verá que foram criadas 4 abas automaticamente:
* `FORMS`
* `LOGS`
* `CONFIG`
* `FILA`

No seu Google Drive, foi criada uma pasta chamada **`SETUR Forms`** na raiz.

---

## Passo 5: Configurar o Acesso do Administrador

1. Abra a aba **`CONFIG`** na sua Planilha Mestre.
2. Na linha onde a chave é `emailAdmin`, verifique se o valor corresponde ao seu e-mail de administrador (se não, altere-o).
3. Para definir a sua **senha de acesso ao painel admin**:
   * Escolha a senha desejada (ex: `minhasenha123`).
   * Gere o hash **SHA-256** dessa senha. Você pode fazer isso em qualquer gerador online (como [SHA256 Online](https://passwordsgenerator.net/sha256-hash-generator/)) ou executando a seguinte linha no console do Apps Script:
     ```javascript
     console.log(hashSHA256("sua_senha"));
     ```
   * Copie o hash de 64 caracteres gerado (exemplo: `a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3` para `123456`).
   * Cole este hash na aba `CONFIG`, na coluna de **valor** correspondente à chave **`senhaHash`**.

---

## Passo 6: Implantar como Web App

1. No canto superior direito do Apps Script, clique no botão **Implantar** > **Nova implantação**.
2. Clique no ícone de engrenagem ao lado de "Selecionar tipo" e escolha **Web app**.
3. Preencha as configurações:
   * **Descrição:** `Versão Inicial SETUR Forms`
   * **Executar como:** **`Você (seu-email@gmail.com)`** (Isso é obrigatório para que o script grave no seu Drive e Planilhas sem exigir login dos respondentes).
   * **Quem tem acesso:** **`Qualquer pessoa`** (Permite que o público responda aos formulários sem precisar de conta Google).
4. Clique em **Implantar**.
5. Copie a **URL do Web App** gerada (exemplo: `https://script.google.com/macros/s/AKfycb.../exec`).

---

## Passo 7: Acionadores Automáticos (Instalação Automática)

> [!IMPORTANT]
> **Você não precisa criar os acionadores manualmente!** A execução da função `setup()` (Passo 4) já cria e instala automaticamente todos os triggers necessários na sua conta do Google Apps Script. 

Caso você precise recriá-los ou queira verificar a configuração no menu lateral de **Relógio** (Acionadores/Triggers), os intervalos corretos são:

#### 1. Processador da Fila (`processarFila`)
* **Intervalo:** Baseado no tempo → Temporizador de minutos → **A cada 5 minutos**.

#### 2. Fechamento Programado (`verificarEncerramentoProgramado`)
* **Intervalo:** Baseado no tempo → Temporizador de minutos → **A cada 10 minutos**.

#### 3. Reconciliador de Intenções (`reconciliarIntencoes`)
* **Intervalo:** Baseado no tempo → Temporizador de minutos → **A cada 10 minutos**.

#### 4. Notificações Diárias (`enviarNotificacoesPendentes`)
* **Intervalo:** Baseado no tempo → Temporizador diário → **Entre 8h e 9h**.

---

## Passo 8: Como Acessar a Plataforma

* **Página Inicial Pública:** Acesse a URL do Web App gerada no Passo 6.
  * `https://script.google.com/macros/s/AKfycb.../exec`
* **Painel do Administrador:** Adicione `?page=admin` ao final da URL do seu Web App:
  * `https://script.google.com/macros/s/AKfycb.../exec?page=admin`
  * Use a senha cadastrada no Passo 5 para fazer o login.
