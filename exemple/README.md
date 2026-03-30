# Spotfire / Deslocamentos

Esta pasta temporaria concentra os arquivos envolvidos no fluxo de autenticacao do Spotfire, aplicacao de filtros e extracao dos dados de deslocamentos.

## Arquivos copiados

### createDependencies.js
- Origem: `src/bootstrap/createDependencies.js`
- Funcao: monta a injecao de dependencias usada pela aplicacao.
- Papel no fluxo: cria `IntegrationProcessClient`, `RemoteSpotfireProvider`, `RemoteDeslocamentoRepository` e injeta tudo em `DeslocamentoService`.

### SpotfireProvider.js
- Origem: `src/modules/deslocamentos/SpotfireProvider.js`
- Funcao: controla o browser Puppeteer do Spotfire.
- Responsabilidades principais:
  - abrir o browser
  - acessar o relatorio
  - autenticar no login do Spotfire
  - detectar sessao expirada
  - resetar e recriar a sessao quando a conexao cai

### DeslocamentoRepository.js
- Origem: `src/modules/deslocamentos/DeslocamentoRepository.js`
- Funcao: automatiza a UI do Spotfire para aplicar filtros e ler a tabela.
- Responsabilidades principais:
  - selecionar filtros fixos como `Area` e `Disponibilidade`
  - selecionar `Base` por polo
  - localizar o controle correto do filtro `Base`
  - maximizar a visualizacao da tabela
  - percorrer a tabela com scroll
  - extrair e mapear as linhas para objetos de dominio

### DeslocamentoService.js
- Origem: `src/modules/deslocamentos/DeslocamentoService.js`
- Funcao: orquestra chamadas ao Spotfire e mantem cache em memoria.
- Responsabilidades principais:
  - serializar acesso ao Spotfire
  - inicializar o provider
  - chamar o repository para buscar um polo ou todos
  - armazenar cache por polo
  - recuperar a sessao e repetir a operacao em falhas recuperaveis

### RemoteSpotfireProvider.js
- Origem: `src/integrations/remote/RemoteSpotfireProvider.js`
- Funcao: wrapper do processo principal para falar com o worker remoto.
- Papel no fluxo: expor `initialize`, `shutdown` e `resetSession` sem instanciar Puppeteer diretamente no processo web.

### RemoteDeslocamentoRepository.js
- Origem: `src/integrations/remote/RemoteDeslocamentoRepository.js`
- Funcao: wrapper remoto para as operacoes de extracao.
- Papel no fluxo: encaminhar `findByPolo` e `findAll` para o worker.

### integration-worker.js
- Origem: `src/integrations/remote/integration-worker.js`
- Funcao: processo separado que instancia os componentes reais do Spotfire.
- Papel no fluxo:
  - cria `SpotfireProvider`
  - cria `DeslocamentoRepository`
  - recebe comandos IPC do processo principal
  - executa autenticacao, reset de sessao e extracao remota

## Sequencia do fluxo

1. `createDependencies.js` monta `DeslocamentoService` com wrappers remotos.
2. `DeslocamentoService` chama `RemoteSpotfireProvider` e `RemoteDeslocamentoRepository`.
3. Os wrappers enviam comandos para `integration-worker.js`.
4. O worker usa `SpotfireProvider.js` para login e manutencao da sessao.
5. O worker usa `DeslocamentoRepository.js` para aplicar filtros e extrair a tabela.
6. O resultado volta ao service, que atualiza cache e entrega a resposta para a aplicacao.

## Onde olhar primeiro

- Login Spotfire: `SpotfireProvider.js`
- Filtro `Base`, `Area` e `Disponibilidade`: `DeslocamentoRepository.js`
- Retry e reconexao: `DeslocamentoService.js` e `SpotfireProvider.js`
- Encadeamento remoto: `createDependencies.js` e `integration-worker.js`