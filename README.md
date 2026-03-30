# Displacement Analysis System

Sistema modular de análise de deslocamento de equipes operacionais.

## 📁 Estrutura do Projeto

```
src/
├── config/                 # Configurações e settings
│   ├── __init__.py
│   └── settings.py         # Configurações centralizadas
├── core/                   # Núcleo da aplicação
│   ├── __init__.py
│   ├── models.py           # Modelos de domínio (DTOs)
│   └── utils.py            # Utilitários (datetime, columns)
├── services/               # Serviços de negócio
│   ├── __init__.py
│   ├── data_loader.py      # Carregamento de dados CSV
│   ├── calculator.py       # Cálculo de métricas
│   ├── aggregator.py       # Agregação por equipe/dia
│   └── pipeline.py         # Orquestração do pipeline
├── reports/                # Geração de relatórios
│   ├── __init__.py
│   ├── docx_builder.py     # Builder para documentos Word
│   └── report_generator.py # Gerador de relatórios ABNT
├── data/                   # Dados de entrada
│   └── deslocamento.csv    # Arquivo de dados
├── __init__.py             # Package init
├── __main__.py             # Execução como módulo
└── main.py                 # Ponto de entrada principal

result/                     # Saída (gerado automaticamente)
├── deslocamento_calculado.csv
├── medias_por_equipe_dia.csv
├── medias_Improdutivas_por_equipe_dia.csv
└── relatorio_analise_equipes.docx
```

## 🚀 Instalação

### Pré-requisitos
- Python 3.10+
- pip

### Setup

1. Clone o repositório:
```bash
git clone https://github.com/alyssonlcss/compute_and_analyze_displacement.git
cd compute_and_analyze_displacement
```

2. Crie um ambiente virtual:
```bash
python -m venv .venv
```

3. Ative o ambiente virtual:
```bash
# Windows
.venv\Scripts\activate

# Linux/Mac
source .venv/bin/activate
```

4. Instale as dependências:
```bash
pip install -r requirements.txt
```

## 📊 Uso

### Executar a análise completa:

```bash
# Opção 1: Executar como módulo
python -m src.main

# Opção 2: Executar diretamente
python src/main.py
```

### Saídas geradas:

| Arquivo | Descrição |
|---------|-----------|
| `result/deslocamento_calculado.csv` | Dados com métricas calculadas |
| `result/medias_por_equipe_dia.csv` | Médias produtivas por equipe/dia |
| `result/medias_Improdutivas_por_equipe_dia.csv` | Médias improdutivas por equipe/dia |
| `result/relatorio_analise_equipes.docx` | Relatório ABNT formatado |

## 📈 Métricas Calculadas

| Métrica | Descrição | Como é calculada |
|---------|-----------|------------------|
| `TempPrep_min` | Tempo de preparação | A_Caminho - (PrevLiberada ou Despachada). Calculado por ordem, depois somado por jornada (InicioCalendario_dt, FimCalendario_dt) |
| `TempExe_min` | Tempo de execução | Liberada - No_Local. Calculado por ordem, depois média por equipe/dia |
| `TempDesl_min` | Tempo de deslocamento | No_Local - A_Caminho. Calculado por ordem, depois média por equipe/dia |
| `InterReg_min` | Intervalo regulamentar | Fim_Intervalo - Inicio_Intervalo. Calculado por ordem, depois média por equipe/dia |
| `TempSemOrdem` | Tempo sem ordem | Jornada - HD Total - TempPrep - Intervalo - Retorno a base. Calculado por jornada (InicioCalendario_dt, FimCalendario_dt) |
| `Media_TempSemOrdem` | Tempo sem ordem (agregado) | **Nas planilhas de médias:** para cada dia, é a soma dos TempSemOrdem de todas as jornadas daquele dia/equipe (não é média dos valores!). Apenas na linha 'MédiaTodosDias' é feita a média dos dias. |
| `qtd_ordem` | Quantidade de ordens | Contagem de registros por equipe/dia |
| `Retorno a base` | Retorno a base | Primeiro valor não nulo por equipe/dia |

### Regras de agregação e médias

- **Planilha deslocamento_calculado.csv:** mostra todos os valores calculados por ordem e por jornada, sem agregação.
- **Planilhas de médias (medias_por_equipe_dia.csv, medias_Improdutivas_por_equipe_dia.csv):**
	- Para a maioria das métricas, é feita a média dos valores por equipe/dia.
	- Para `Media_TempSemOrdem`, o valor diário é a soma dos TempSemOrdem de todas as jornadas daquele dia/equipe (não é média!). Apenas a linha 'MédiaTodosDias' mostra a média dos dias.
	- Para `Retorno a base`, é considerado o primeiro valor não nulo do dia.
	- Para `qtd_ordem`, é a contagem de registros por equipe/dia.

## 🏗️ Arquitetura

O projeto segue os princípios de **Clean Architecture**:

- **Config**: Configurações centralizadas e injetáveis
- **Core**: Modelos de domínio e utilitários puros
- **Services**: Lógica de negócio encapsulada em serviços
- **Reports**: Geração de documentos desacoplada

### Padrões utilizados:

- **Dependency Injection**: Settings injetáveis em todos os serviços
- **Builder Pattern**: DocxBuilder para construção fluente de documentos
- **Pipeline Pattern**: ProcessingPipeline para orquestração
- **Repository Pattern**: DataLoaderService para acesso a dados
- **Single Responsibility**: Cada módulo tem uma responsabilidade única

## 🔧 Configuração

As configurações estão em `src/config/settings.py`:

```python
from src.config import get_settings

settings = get_settings()

# Acessar configurações
print(settings.files.input_file)
print(settings.metrics.tempo_util_meta)
```

## 🎨 Customizando temas do Excel

Você pode personalizar cores e comportamento de formatação do Excel usando um arquivo `.env` na raiz do projeto.

- Copie o arquivo `.env.example` (fornecido) para `.env` e ajuste os valores hexadecimais e flags.
- Chaves gerais começam com `EXCEL_` (ex.: `EXCEL_HEADER_BG`, `EXCEL_ROW_EVEN`).
- A configuração específica para a aba **Média Geral** usa o prefixo `EXCEL_MEDIAS_GERAL_` (ex.: `EXCEL_MEDIAS_GERAL_HEADER_BG`).
- Flags booleans: `EXCEL_DISABLE_TEAM_ZEBRA` e `EXCEL_DISABLE_DATE_ZEBRA` ou o equivalente por tema `EXCEL_MEDIAS_GERAL_DISABLE_TEAM_ZEBRA`.

Exemplo rápido:

```env
EXCEL_MEDIAS_GERAL_HEADER_BG=#1F618D
EXCEL_MEDIAS_GERAL_ROW_ODD=#F0F8FF
EXCEL_MEDIAS_GERAL_DISABLE_TEAM_ZEBRA=false
```

Após editar `.env`, reexecute a análise para aplicar os temas:

```bash
python src/main.py
```


## 📝 Metas de Análise


📝 Metas de Análise

| Métrica                | Meta para médias Produtivo | Meta para médias Improdutivas |
|------------------------|----------------------------|-------------------------------|
| Media_TempExe          | <=50 min                   | <=20 min                      |
| Media_InterReg         | <=60 min                   | <=60 min                      |
| Utilização             | >=85% da Media_Jornada     | >=85% da Media_Jornada        |
| Retorno a base         | <=40 min                   | <=40 min                      |
| Media_TempPrep   | <=10 min                   | <=10 min                      |
|                        |                            |                               |
| qtd_ordem              | >=5                        | >=5                           |


## 📋 Glossário de Métricas (Original)

| Sigla | Descrição |
|-------|-----------|
| HT total | Deslocamento + execução (valor por dia) |
| TR Ordem | Tempo de reparo (valor por ordem) |
| TL Ordem | Tempo de deslocamento (valor por ordem) |
| HT Ordem | Deslocamento + execução (valor por ordem)
| tempo_padrao | Tempo padrão de reparo - expectativa (valor por ordem)|
| Retorno a base | valor por dia |
| Horas Extras | valor por dia |

## 🧪 Desenvolvimento

### Linting:
```bash
pip install black isort flake8
black src/
isort src/
flake8 src/
```

## 📄 Licença

MIT License

## 👤 Autor

Alysson - [@alyssonlcss](https://github.com/alyssonlcss)