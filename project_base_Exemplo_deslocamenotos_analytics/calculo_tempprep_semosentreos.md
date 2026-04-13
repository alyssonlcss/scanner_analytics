# Documentação dos Cálculos: TempPrep e SemOSentreOS

## Índice

1. [Pré-requisitos Comuns](#pré-requisitos-comuns)
2. [Colunas de Entrada](#colunas-de-entrada)
3. [TempPrep (Tempo de Preparação)](#tempprep-tempo-de-preparação)
4. [SemOSentreOS (Tempo sem Ordem entre Ordens)](#semosentreos-tempo-sem-ordem-entre-ordens)
5. [Diferenças-chave entre TempPrep e SemOSentreOS](#diferenças-chave-entre-tempprep-e-semosentreos)
6. [Fluxo de Ordenação](#fluxo-de-ordenação)
7. [Exemplos Práticos](#exemplos-práticos)

---

## Pré-requisitos Comuns

Ambos os cálculos compartilham a mesma estrutura de preparação:

1. **Ordenação**: O DataFrame é ordenado por `Equipe`, `Data Referência` e `A_Caminho` (parse temporário via `pd.to_datetime`, sem criar coluna `_dt` persistente).
2. **Agrupamento**: Itera-se por `(Equipe, Data Referência)` usando `groupby`.
3. **Ordenação interna do grupo**: Dentro de cada grupo, as linhas são re-ordenadas por `A_Caminho` (parse temporário) e o índice é resetado para acesso posicional (`grupo.loc[i, ...]`).
4. **Controle de intervalo**: Uma flag booleana (`is_inter_a_caminho` para TempPrep, `is_inter_ordem` para SemOSentreOS) garante que o desconto do intervalo de almoço seja aplicado **apenas uma vez** por equipe/dia.

---

## Colunas de Entrada

Colunas lidas diretamente do CSV:

| Coluna              | Tipo     | Uso                                              |
|---------------------|----------|--------------------------------------------------|
| `Equipe`            | string   | Agrupamento por equipe                           |
| `Data Referência`   | date     | Agrupamento por dia                              |
| `A_Caminho`         | datetime | Ordenação cronológica dentro do grupo            |
| `Despachada`        | datetime | Timestamp do despacho da OS atual (`i`)          |
| `Liberada`          | datetime | Timestamp de liberação da OS anterior (`i-1`)    |
| `1º Desloc`         | numérico | Valor direto para a 1ª ordem (usado em TempPrep) |
| `1º Despacho`       | numérico | Valor direto para a 1ª ordem (usado em SemOSentreOS) |
| `Inicio Intervalo`  | datetime | Início do intervalo de almoço                    |
| `Fim Intervalo`     | datetime | Fim do intervalo de almoço                       |
| `Intervalo`         | numérico | Duração do intervalo em minutos                  |

---

## TempPrep (Tempo de Preparação)

**Colunas calculadas**:
- `TempPrep` — valor por OS (linha)
- `TempPrepJornada` — somatório de todos os `TempPrep` da equipe/dia

### Primeira ordem do dia (`i = 0`)

```
TempPrep[0] = valor da coluna "1º Desloc"
```

Sem cálculo de diferença de timestamps. O valor é copiado diretamente (com conversão de vírgula para ponto).

---

### Demais ordens (`i >= 1`)

A decisão principal é:

> **`Despachada[i] > Liberada[i-1]`?**

---

### RAMO A: `Despachada[i] > Liberada[i-1]`

A equipe foi despachada **depois** de ter sido liberada da OS anterior. Indica que houve uma pausa real entre as ordens.

#### Cenário A1 — Intervalo intercepta o despacho

**Condição:**
```
Liberada[i-1] < InicioIntervalo < Despachada[i] < FimIntervalo <= A_Caminho[i]
AND is_inter == False
```

**Descrição:** O despacho ocorreu *durante* o intervalo de almoço. O intervalo "corta" o período entre a liberação e o deslocamento.

**Fórmula:**
```
TempPrep = (A_Caminho[i] - FimIntervalo) / 60   (em minutos)
```

Se a duração do intervalo exceder 60 minutos:
```
duracao_intervalo = (FimIntervalo - InicioIntervalo) / 60
se duracao_intervalo > 60:
    TempPrep += duracao_intervalo - 60
```

**Flag:** `is_inter = True` (intervalo já foi tratado neste dia).

---

#### Cenário A2 — Sem intervalo relevante (caso padrão)

**Condição:** Não satisfaz A1.

**Fórmula:**
```
TempPrep = (A_Caminho[i] - Despachada[i]) / 60
```

---

#### Cenário A2b — Intervalo contido com tolerância ±10 min

**Condição (verificada após A2):**
```
InicioIntervalo >= Despachada[i] - 10min
AND FimIntervalo <= A_Caminho[i] + 10min
AND is_inter == False
```

**Descrição:** O intervalo está totalmente contido entre o despacho e o deslocamento, com uma margem de 10 minutos de tolerância.

**Fórmula:** Mesmo cálculo de A2, depois aplica desconto:
```
TempPrep -= min(Intervalo, 60)
excedente = Intervalo - 60
se excedente > 0:
    TempPrep += excedente
se TempPrep < 0:
    TempPrep = 0
```

**Flag:** `is_inter = True`, `desconta_intervalo = True`.

---

### RAMO B: `Despachada[i] <= Liberada[i-1]`

A equipe foi despachada **antes** ou **no mesmo momento** em que foi liberada. Indica que já havia uma OS na fila (pré-despacho).

#### Cenário B1 — Intervalo entre Liberada e A_Caminho

**Condição:**
```
Liberada[i-1] < InicioIntervalo
AND FimIntervalo < A_Caminho[i]
AND is_inter == False
```

**Descrição:** O intervalo ocorreu entre a liberação da OS anterior e o início do deslocamento para a próxima.

**Fórmula:**
```
TempPrep = (A_Caminho[i] - FimIntervalo) / 60
```

Se a duração do intervalo exceder 60 minutos:
```
duracao_intervalo = (FimIntervalo - InicioIntervalo) / 60
se duracao_intervalo > 60:
    TempPrep += duracao_intervalo - 60
```

**Flag:** `is_inter = True`.

---

#### Cenário B2 — Sem intervalo relevante (caso padrão)

**Condição:** Não satisfaz B1.

**Fórmula:**
```
TempPrep = (A_Caminho[i] - Liberada[i-1]) / 60
```

---

#### Cenário B2b — Intervalo contido com tolerância ±10 min

**Condição (verificada após B2):**
```
InicioIntervalo >= Liberada[i-1] - 10min
AND FimIntervalo <= A_Caminho[i] + 10min
AND is_inter == False
```

**Fórmula:** Mesmo cálculo de B2, depois aplica desconto:
```
TempPrep -= min(Intervalo, 60)
excedente = Intervalo - 60
se excedente > 0:
    TempPrep += excedente
se TempPrep < 0:
    TempPrep = 0
```

**Flag:** `is_inter = True`, `desconta_intervalo = True`.

---

### TempPrepJornada (totalização)

```
TempPrepJornada = nansum(TempPrep de todas as OS da equipe/dia)
```

O valor é repetido para todas as linhas do mesmo grupo `(Equipe, Data Referência)`.

---

## SemOSentreOS (Tempo sem Ordem entre Ordens)

**Colunas calculadas**:
- `SemOSentreOS` — valor por OS (linha)
- `SemOrdemJornada` — somatório total do dia

### Primeira ordem do dia (`i = 0`)

```
SemOSentreOS[0] = valor da coluna "1º Despacho"
```

O valor da coluna `Intervalo` da primeira linha é lido para uso posterior nos cenários com intervalo.

---

### Demais ordens (`i >= 1`)

A decisão principal é:

> **`Despachada[i] > Liberada[i-1]`?**

---

### RAMO A: `Despachada[i] > Liberada[i-1]`

#### Cenário A1 — Intervalo intercepta o despacho

**Condição:**
```
Liberada[i-1] < InicioIntervalo < Despachada[i] < FimIntervalo
AND is_inter == False
```

**Descrição:** O despacho ocorreu durante o intervalo. O tempo ocioso real é apenas o período entre a liberação e o início do intervalo.

**Fórmula:**
```
SemOSentreOS = (InicioIntervalo - Liberada[i-1]) / 60
```

**Flag:** `is_inter = True`.

---

#### Cenário A2 — Sem intervalo relevante (caso padrão)

**Condição:** Não satisfaz A1.

**Fórmula:**
```
SemOSentreOS = (Despachada[i] - Liberada[i-1]) / 60
```

---

#### Cenário A2b — Intervalo contido com tolerância ±10 min

**Condição (verificada após A2):**
```
InicioIntervalo >= Liberada[i-1] - 10min
AND FimIntervalo <= Despachada[i] + 10min
AND is_inter == False
```

**Fórmula:** Mesmo cálculo de A2, depois aplica desconto:
```
SemOSentreOS -= min(Intervalo, 60)
excedente = Intervalo - 60
se excedente > 0:
    SemOSentreOS += excedente
se SemOSentreOS < 0:
    SemOSentreOS = 0
```

**Flag:** `is_inter = True`, `desconta_intervalo = True`.

---

### RAMO B: `Despachada[i] <= Liberada[i-1]`

**Nenhum cálculo.** O `SemOSentreOS` permanece `NaN`.

A equipe foi despachada antes de ser liberada, ou seja, já havia uma OS na fila. Não houve tempo ocioso entre as ordens.

---

### SemOrdemJornada (totalização)

```
SemOrdemJornada = valor_1o_despacho + soma(SemOSentreOS[i] para i=1..n)
```

É um acumulador: inicia com o valor da primeira ordem e soma os valores de `entreos` (já ajustados por desconto de intervalo quando aplicável). O valor é repetido para todas as linhas do mesmo grupo `(Equipe, Data Referência)`.

---

## Diferenças-chave entre TempPrep e SemOSentreOS

| Aspecto                          | TempPrep                                                   | SemOSentreOS                                              |
|----------------------------------|------------------------------------------------------------|------------------------------------------------------------|
| **1ª ordem (i=0)**               | `1º Desloc`                                                | `1º Despacho`                                              |
| **Referência (sem intervalo, Ramo A)** | `A_Caminho[i] - Despachada[i]`                        | `Despachada[i] - Liberada[i-1]`                            |
| **Referência (sem intervalo, Ramo B)** | `A_Caminho[i] - Liberada[i-1]`                        | `NaN` (sem cálculo)                                       |
| **Intervalo intercepta (Ramo A)**| `A_Caminho[i] - FimIntervalo`                              | `InicioIntervalo - Liberada[i-1]`                          |
| **Intervalo intercepta (Ramo B)**| `A_Caminho[i] - FimIntervalo`                              | (não se aplica)                                            |
| **Tolerância intervalo contido** | `Despachada ± 10min` / `A_Caminho ± 10min`                | `Liberada ± 10min` / `Despachada ± 10min`                  |
| **Ramo B calcula?**              | Sim                                                        | Não (NaN)                                                  |
| **Totalização diária**           | `TempPrepJornada` = `nansum(lista)`                        | `SemOrdemJornada` = `1ºDespacho + acumulador`              |

---

## Fluxo de Ordenação

```
CSV bruto
  → pd.to_datetime(A_Caminho) como coluna temporária
    → sort_values([Equipe, Data Referência, _tmp_a_caminho])
      → drop coluna temporária
        → groupby([Equipe, Data Referência])
          → sort interno do grupo por A_Caminho (temporário)
            → reset_index() preservando índice original em coluna 'index'
              → iteração sequencial i = 0..n
```

A ordenação é executada **duas vezes** — uma em `_calculate_temp_prep_equipe` e outra em `_calculate_sem_ordem_jornada` — usando a mesma lógica.

---

## Exemplos Práticos

### Exemplo 1 — Dia normal sem intervalo entre ordens

| i | A_Caminho | Despachada | Liberada (i-1) | TempPrep | SemOSentreOS |
|---|-----------|------------|----------------|----------|--------------|
| 0 | 08:30     | 08:00      | —              | `1ºDesloc = 15` | `1ºDespacho = 20` |
| 1 | 10:05     | 09:50      | 09:45          | `(10:05 - 09:50) = 15` | `(09:50 - 09:45) = 5` |
| 2 | 11:30     | 11:20      | 11:15          | `(11:30 - 11:20) = 10` | `(11:20 - 11:15) = 5` |

- `TempPrepJornada = 15 + 15 + 10 = 40`
- `SemOrdemJornada = 20 + 5 + 5 = 30`

### Exemplo 2 — Intervalo de almoço intercepta o despacho (Ramo A, Cenário A1)

| i | A_Caminho | Despachada | Liberada (i-1) | InicioIntervalo | FimIntervalo |
|---|-----------|------------|----------------|-----------------|--------------|
| 1 | 13:30     | 12:30      | 11:45          | 12:00           | 13:00        |

**TempPrep (A1):**
- Condição: `11:45 < 12:00 < 12:30 < 13:00 <= 13:30` ✓
- `TempPrep = (13:30 - 13:00) = 30 min`
- Duração intervalo = 60 min (não excede 60, sem ajuste).

**SemOSentreOS (A1):**
- Condição: `11:45 < 12:00 < 12:30 < 13:00` ✓
- `SemOSentreOS = (12:00 - 11:45) = 15 min`

### Exemplo 3 — Pré-despacho, intervalo entre Liberada e A_Caminho (Ramo B, Cenário B1)

| i | A_Caminho | Despachada | Liberada (i-1) | InicioIntervalo | FimIntervalo |
|---|-----------|------------|----------------|-----------------|--------------|
| 1 | 13:45     | 11:30      | 11:45          | 12:00           | 13:00        |

**TempPrep (B1):**
- `Despachada (11:30) <= Liberada (11:45)` → Ramo B
- `11:45 < 12:00` e `13:00 < 13:45` ✓
- `TempPrep = (13:45 - 13:00) = 45 min`

**SemOSentreOS (Ramo B):**
- `SemOSentreOS = NaN` (não se aplica)

### Exemplo 4 — Intervalo contido com desconto (Cenário A2b)

| i | A_Caminho | Despachada | Liberada (i-1) | InicioIntervalo | FimIntervalo | Intervalo |
|---|-----------|------------|----------------|-----------------|--------------|-----------|
| 1 | 14:00     | 11:50      | 11:40          | 12:00           | 13:15        | 75        |

**TempPrep (A2b):**
- `TempPrep = (14:00 - 11:50) = 130 min`
- `InicioIntervalo (12:00) >= 11:50 - 10min (11:40)` ✓
- `FimIntervalo (13:15) <= 14:00 + 10min (14:10)` ✓
- Desconto: `130 - min(75, 60) = 70`
- Excedente: `75 - 60 = 15` → `70 + 15 = 85 min`

**SemOSentreOS (A2b):**
- `SemOSentreOS = (11:50 - 11:40) = 10 min`
- Desconto: `10 - min(75, 60) = -50` → excedente `+15` → `-35` → `0.0` (floor)

---

## Lógica de Desconto de Intervalo (comum)

Aplicada quando `desconta_intervalo = True`:

```python
valor -= min(intervalo_float, 60.0)   # desconta no máximo 60 min
excedente = intervalo_float - 60.0
if excedente > 0:
    valor += excedente                 # devolve o que passou de 60 min
if valor < 0:
    valor = 0.0                        # nunca fica negativo
```

**Regra:** O intervalo de almoço regulamentar é de 60 minutos. Se a equipe gastou mais do que 60 min, o excedente é somado de volta ao tempo calculado (penalização). Se gastou exatamente 60 ou menos, desconta o valor real.

---

## Regra da Flag de Intervalo

- A flag (`is_inter_a_caminho` / `is_inter_ordem`) é inicializada como `False` no início de cada grupo `(Equipe, Data Referência)`.
- Ao encontrar o **primeiro** cenário que envolve intervalo (A1, A2b, B1, B2b), a flag é marcada como `True`.
- Uma vez `True`, **nenhum outro cenário com intervalo será aplicado** naquele dia para aquela equipe.
- Isso garante que o desconto de almoço ocorra **uma única vez** por equipe/dia.
