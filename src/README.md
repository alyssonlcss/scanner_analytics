## Scanner Analytics

Este diretório passa a concentrar a nova aplicação do Scanner 4.0 - CE.

### Estrutura

- `backend/`: API Node.js + TypeScript com arquitetura hexagonal e automação Puppeteer para Spotfire.
- `frontend/`: Angular standalone para orquestrar execuções e acompanhar resultados.

### Decisões de arquitetura

- Backend em TypeScript com Fastify para manter baixa sobrecarga e boa composição com Puppeteer.
- Automação isolada atrás de uma porta de domínio para permitir futura troca de Puppeteer por Playwright sem impacto nas camadas superiores.
- Frontend em Angular standalone com organização por feature.
- Toda referência de URL, credencial e rótulo textual do Spotfire fica no `.env` do backend.

### Próximo passo esperado

Instalar dependências em `backend` e `frontend`, preencher o `.env` do backend e validar a automação no ambiente real do Spotfire.