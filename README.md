# Scanner Analytics

Scanner Analytics é uma aplicação Full-Stack desenvolvida para extração automatizada, processamento analítico e geração de relatórios de produtividade.

O sistema utiliza automação de navegação (RPA) para baixar bases de dados operacionais de maneira autônoma via Puppeteer, processa esses dados em um backend robusto construído com Node.js + Fastify, e exibe as métricas de desempenho através de um dashboard interativo moderno desenvolvido em Angular. A partir do dashboard, é possível visualizar o desempenho operacional das equipes, verificar o status dos alertas e gerar/exportar relatórios analíticos em PDF de maneira dinâmica e segmentada.

## 🚀 Tecnologias

- **Frontend**: Angular (Standalone Components), RxJS, Signals, PDFMake (para renderização de PDFs nativa no lado do cliente).
- **Backend**: Node.js, Fastify, TypeScript, Zod, Puppeteer (para RPA web).
- **Arquitetura**: Hexagonal Architecture no backend (focada na separação de domínios), arquitetura limpa de componentes e separação por "features" no Frontend.

## 📁 Estrutura do Projeto

- `src/backend/`: API em Node.js e orquestrador de automação. Responsável por iniciar a raspagem de dados em fontes externas, filtrar arquivos baixados (CSV), tratar regras e cálculos complexos de negócio e devolver os dados agregados prontos para consumo.
- `src/frontend/`: SPA (Single Page Application) em Angular. Consome a API, renderiza o dashboard dinâmico (gráficos e alertas) e fornece a interface para a geração e compartilhamento automático de PDFs em lote para Windows.

## 📊 Métricas e Cálculos

O Scanner Analytics não apenas exibe dados brutos, mas realiza uma série de cruzamentos analíticos (Deep Dive) para expor gargalos operacionais ocultos que geralmente passam despercebidos nas médias mensais.

### Principais KPIs e Fórmulas Analíticas:
- **Eficiência**: Mede a precisão da execução frente à expectativa. 
  - *Cálculo*: `Tempo Padrão Total / Tempo de Reparo (TR) Total`. 
  - *Análise*: O sistema caça discrepâncias investigando ordens onde o TR excedeu drasticamente a estimativa, revelando baixa eficiência "mascarada" em equipes que cumprem a meta apenas fazendo volume em ordens fáceis.
- **Utilização**: Mede o quão bem o tempo do eletricista está sendo aproveitado.
  - *Cálculo*: `Horas Trabalhadas (HT) / Horas Disponíveis (HD)`.
  - *Análise*: A engine cruza inícios e fins de ordem, calculando lacunas exatas de ociosidade (*"Tempo Sem OS"*) para diagnosticar se a culpa da baixa utilização é da equipe (paradas longas) ou do centro de despacho (falta de serviço na rota).
- **Produtividade (OS/Dia)**: Contagem bruta de OS executadas.
- **TME (Tempo Médio de Execução) Improdutivo**: Avalia o excesso de tempo gasto em deslocamento frente à execução. Picos de improdutividade geram alertas imediatos e são cruzados com o raio de atuação.
- **Eventos de Jornada (1º Login / 1º Deslocamento / Retorno à Base)**: Auditoria diária de rotina. Algoritmos identificam equipes que sistematicamente iniciam a jornada com atraso ou encerram a rota de forma prematura.

## 📑 Tipos de Relatórios Gerados

Ao exportar os PDFs pelo painel, o relatório é inteligentemente dividido em duas frentes de diagnóstico:

### 1. Visão Operacional (Resumo Executivo)
Desenhado para o coordenador da base. É um *Scorecard* macro que responde à pergunta *"Onde está sangrando?"*.
- Consolida os alertas em formato de farol (KPIs críticos).
- Mostra um ranking simples das piores equipes.
- Ignora os bons números para focar exclusivamente nos desvios padrão (ausências injustificadas, excesso de recusas e falhas de comunicação).

### 2. Visão Analítica (Raio-X de Evidências)
Desenhado para o analista e para a reunião de feedback com a equipe. É um aprofundamento investigativo (*Deep Dive*).
- Separa os *Top Performers* (melhores) dos *Underperformers* (piores) em cada indicador.
- Substitui médias mensais por **Gráficos de Tendência Diária** (linhas de acompanhamento dia a dia).
- Fornece **Evidências Nível OS**: O relatório analítico não diz apenas que a equipe está ociosa; ele lista no PDF o **número da OS exata**, o horário e a duração dos tempos absurdos identificados (ex: *"OS 12345 despachada às 14h, mas a equipe ficou 2 horas ociosa antes de assumir"*).

## ⚙️ Pré-requisitos

- **Node.js** v18 ou superior
- **NPM** (Node Package Manager)
- Um navegador baseado em Chromium (Edge ou Google Chrome) para a execução do Puppeteer.

## 🛠️ Instalação e Execução

### Opção 1: Utilizando o script automatizado (Recomendado para Windows)
Na raiz do projeto, execute o script `setup.bat`:
```bat
setup.bat
```
Ele instalará as dependências de ambos os subprojetos (Frontend e Backend) automaticamente e iniciará os dois servidores em terminais dedicados.

### Opção 2: Execução Manual
Se preferir executar e inspecionar manualmente, siga os passos em dois terminais distintos:

#### Backend
```bash
cd src/backend
npm install
# Preencha as variáveis de ambiente necessárias (como a porta, se desejar)
# Inicialize o servidor em modo de desenvolvimento
npm run dev
```

#### Frontend
Em um novo terminal:
```bash
cd src/frontend
npm install
# Inicialize o servidor do Angular
npm start
```
Após o build inicial, o aplicativo frontend estará acessível em `http://localhost:4200`.

## ⚙️ Configuração Adicional

O projeto pode exigir variáveis de ambiente específicas para o acesso aos sistemas fontes, bem como credenciais ou configurações de diretório de extração, dependendo da sua fonte de BI original.
Todas as referências textuais externas ou URLs dinâmicas para a automação estão devidamente desacopladas no arquivo `.env` do backend.

- A estrutura de **polos** e **bases operacionais** que aparecem nos filtros e no exportador é dinamicamente lida e totalmente customizável através do arquivo `src/backend/bases.json`.