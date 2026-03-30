## Backend

API responsável por orquestrar a automação do Spotfire e expor endpoints para o frontend Angular.

### Stack

- Node.js + TypeScript
- Fastify
- Puppeteer
- Zod para configuração e contratos

### Arquitetura

- `application/`: casos de uso
- `domain/`: entidades e portas
- `infrastructure/`: implementação Puppeteer, configuração e armazenamento em memória
- `presentation/`: HTTP API

### Regras atendidas

- Nenhuma URL do Spotfire é hardcoded.
- Toda navegação relevante usa texto, títulos e atributos estáveis antes de qualquer tentativa baseada em estrutura volátil.
- O fluxo padrão garante: login, abertura do relatório, abertura do painel de filtros, reset, scroll completo dos filtros e coleta dos títulos encontrados.

### Endpoints

- `GET /api/health`
- `POST /api/scanner/executions`
- `GET /api/scanner/executions/:jobId`
- `GET /api/scanner/filters/:jobId`