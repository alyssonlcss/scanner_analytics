/**
 * DeslocamentoRepository
 *
 * Navega o Spotfire via SpotfireProvider, aplica filtros,
 * extrai a tabela de Deslocamentos e mapeia cada linha para
 * um objeto Deslocamento.
 */
const Deslocamento = require('./Deslocamento');
const Logger = require('../../shared/Logger');

// ── Seletores da UI do Spotfire ──────────────────────────────────
const SELECTORS = {
  table: {
    expandButton:    '[title="Maximize visualization"]',
    scrollContainer: '.sfc-scrollable, .ListContainer, .canvas-spreadsheet, .contentContainerParent',
    rows:            '.sf-element-table-row',
    cells:           '.sf-element-table-cell .cell-text',
    headerCells:     '.sf-element-column-header, .sfc-column-header',
  },
};

// Textos dos rótulos visíveis dos filtros HtmlTextAreaControl.
// Usados para localizar os controles em runtime (os IDs mudam a cada recarga).
// NOTA: o rótulo "Base:" tem &nbsp; no HTML — normalizado em _findControlByLabel.
const HTAC_LABELS = {
  area:            'Área:',
  base:            'Base:',
  disponibilidade: 'Disponibilidade:',
};

// GUID estável da visualização "Deslocamentos" no relatório Spotfire.
// O sf-visual-id não muda entre recargas (é o ID interno do relatório).
const TABLE_VISUAL_ID = 'a78f97df-0484-4eee-b7b9-79b732f9e3b0';

// Nomes de exibição possíveis dos polos no Spotfire (atributo title dos itens do filtro Base:)
// Em alguns ambientes o mesmo polo pode aparecer com variações diferentes no filtro Base.
const POLO_DISPLAY = {
  ATLANTICO: ['ATLÂNTICO', 'ATLANTICO'],
  DECEN:     ['CENTRO-NORTE', 'CENTRO NORTE'],
  DNORT:     ['NORTE', 'CENTRO-NORTE', 'CENTRO NORTE', 'DNORT'],
};

function normalizeFilterTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

// Colunas padrão (usadas quando o Spotfire não expõe os headers na DOM)
const DEFAULT_HEADERS = [
  'dia', 'equipe', 'ordem', 'despachado', 'aCaminho',
  'noLocal', 'liberada', 'inicioOs', 'fimOs', 'qtd', 'horas', 'emAtendimento',
];

class DeslocamentoRepository {
  /**
   * @param {import('./SpotfireProvider')} spotfireProvider
   */
  constructor(spotfireProvider) {
    this._spotfire = spotfireProvider;
    this._logger = Logger.create('DeslocamentoRepo');
    this._filtersApplied = false;
  }

  /**
   * Seleciona o polo no Spotfire e retorna os deslocamentos extraídos.
   *
   * @param {keyof typeof POLO_DISPLAY} polo
   * @returns {Promise<{ items: Deslocamento[], total: number }>}
   */
  async findByPolo(polo) {
    const page = this._spotfire.getPage();

    if (!POLO_DISPLAY[polo]) {
      throw new Error(`Polo não reconhecido: "${polo}". Válidos: ${Object.keys(POLO_DISPLAY).join(', ')}`);
    }

    // Verificar sessão ANTES de qualquer operação no frame (waitForIdle)
    // para recuperar de frames desanexados (sessão expirada overnight).
    if (await this._spotfire.ensureSession()) {
      this._filtersApplied = false;
    }

    await this._spotfire.waitForIdle();

    // 1. Se houver outra visualização maximizada, restaurar.
    // Se a própria tabela Deslocamentos já estiver maximizada, mantemos assim.
    await this._restoreIfOtherVisualMaximized(page);

    // 2. Aplicar filtros base única vez por sessão (com retry caso os itens ainda não estejam renderizados)
    if (!this._filtersApplied) {
      // Detectar sessão expirada antes de iniciar os retries
      const reauthed = await this._spotfire.ensureSession();
      if (reauthed) {
        this._logger.info('Sessão re-estabelecida — filtros serão reaplicados nesta extração');
      }

      const MAX_FILTER_RETRIES = 4;
      const FILTER_RETRY_DELAY_MS = 3000;
      for (let attempt = 1; attempt <= MAX_FILTER_RETRIES; attempt++) {
        await this._waitForFiltersReady(page);
        const ok1 = await this._select_emServico(page);
        const ok2 = await this._select_area_norte(page);
        this._filtersApplied = ok1 && ok2;
        if (this._filtersApplied) break;
        if (attempt < MAX_FILTER_RETRIES) {
          this._logger.warn(`Filtros fixos não aplicados (tentativa ${attempt}/${MAX_FILTER_RETRIES}) — aguardando ${FILTER_RETRY_DELAY_MS / 1000}s...`);
          // Verificar novamente se a sessão não expirou durante a espera
          const expired = await this._spotfire.ensureSession();
          if (expired) {
            this._logger.info('Sessão Spotfire re-estabelecida durante retry de filtros — reiniciando contagem');
            // Reiniciar loop desde a tentativa 1
            attempt = 0;
            continue;
          }
          await new Promise((r) => setTimeout(r, FILTER_RETRY_DELAY_MS));
        }
      }
      if (!this._filtersApplied) {
        throw new Error('Painel de filtros do Spotfire não ficou pronto a tempo — tente novamente em alguns instantes');
      }
    }

    // 3. Selecionar polo
    await this._selectPolo(page, polo);
    await this._spotfire.waitForIdle();

    // 4. Garantir que a tabela esteja maximizada
    await this._expandTable(page);

    // 4. Extrair dados com scroll progressivo
    const rawRows = await this._scrollAndExtract(page);

    // 5. Ler cabeçalhos (ou usar os padrão)
    const headers = await this._extractHeaders(page);

    // Requisito: ao chegar ao fim do scroll/extração, restaurar o layout.
    await this._restoreTableIfMaximized(page);

    // 6. Mapear para objetos de domínio
    const items = rawRows.map((cells) => this._toDomain(cells, headers, polo));

    this._logger.info(`[${polo}] ${items.length} deslocamentos extraídos`);

    return { items, total: items.length };
  }

  /**
   * Seleciona Base = (All) no Spotfire e retorna os deslocamentos agregados.
   * Usado quando o filtro master do dashboard é "TODOS".
   *
   * @returns {Promise<{ items: Deslocamento[], total: number }>}
   */
  async findAll() {
    const page = this._spotfire.getPage();

    // Verificar sessão ANTES de qualquer operação no frame (waitForIdle)
    // para recuperar de frames desanexados (sessão expirada overnight).
    if (await this._spotfire.ensureSession()) {
      this._filtersApplied = false;
    }

    await this._spotfire.waitForIdle();

    // 1. Se houver outra visualização maximizada, restaurar.
    // Se a própria tabela Deslocamentos já estiver maximizada, mantemos assim.
    await this._restoreIfOtherVisualMaximized(page);

    // 2. Aplicar filtros fixos uma única vez por sessão (com retry caso os itens ainda não estejam renderizados)
    if (!this._filtersApplied) {
      // Detectar sessão expirada antes de iniciar os retries
      const reauthed = await this._spotfire.ensureSession();
      if (reauthed) {
        this._logger.info('Sessão re-estabelecida — filtros serão reaplicados nesta extração');
      }

      const MAX_FILTER_RETRIES = 4;
      const FILTER_RETRY_DELAY_MS = 3000;
      for (let attempt = 1; attempt <= MAX_FILTER_RETRIES; attempt++) {
        await this._waitForFiltersReady(page);
        const ok1 = await this._select_emServico(page);
        const ok2 = await this._select_area_norte(page);
        this._filtersApplied = ok1 && ok2;
        if (this._filtersApplied) break;
        if (attempt < MAX_FILTER_RETRIES) {
          this._logger.warn(`Filtros fixos não aplicados (tentativa ${attempt}/${MAX_FILTER_RETRIES}) — aguardando ${FILTER_RETRY_DELAY_MS / 1000}s...`);
          // Verificar novamente se a sessão não expirou durante a espera
          const expired = await this._spotfire.ensureSession();
          if (expired) {
            this._logger.info('Sessão Spotfire re-estabelecida durante retry de filtros — reiniciando contagem');
            attempt = 0;
            continue;
          }
          await new Promise((r) => setTimeout(r, FILTER_RETRY_DELAY_MS));
        }
      }
      if (!this._filtersApplied) {
        throw new Error('Painel de filtros do Spotfire não ficou pronto a tempo — tente novamente em alguns instantes');
      }
    }

    // 3. Selecionar Base = (All)
    await this._waitForFiltersReady(page);
    await this._selectBaseAll(page);
    await this._spotfire.waitForIdle();

    // 4. Garantir que a tabela esteja maximizada
    await this._expandTable(page);

    // 5. Extrair dados com scroll progressivo
    const rawRows = await this._scrollAndExtract(page);

    // 6. Ler cabeçalhos (ou usar os padrão)
    const headers = await this._extractHeaders(page);

    // Requisito: ao chegar ao fim do scroll/extração, restaurar o layout.
    await this._restoreTableIfMaximized(page);

    // 7. Mapear para objetos de domínio (polo = TODOS)
    const items = rawRows.map((cells) => this._toDomain(cells, headers, 'TODOS'));

    this._logger.info(`[TODOS] ${items.length} deslocamentos extraídos`);

    return { items, total: items.length };
  }

  // ── Navegação / filtros ──────────────────────────────────────────

  /**
   * Restaura o layout caso alguma visualização esteja maximizada.
   * Enquanto existir qualquer botão "Restore visualization layout" visível,
   * clica nele e aguarda — repetindo até o layout estar normal.
   */
  async _restoreTableIfMaximized(page) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const pos = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll(
          '[title="Restore visualization layout"].sfc-maximize-visual-button'
        ));
        for (const btn of btns) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
        return null;
      });
      if (!pos) break; // nenhum botão restore visível — layout normal
      this._logger.info('Visualização maximizada detectada — restaurando layout...');
      await page.mouse.click(pos.x, pos.y);
      // Espera o botão de restore sumir de fato (mais confiável que só .sf-busy)
      await page
        .waitForFunction(
          () => {
            const btns = Array.from(document.querySelectorAll(
              '[title="Restore visualization layout"].sfc-maximize-visual-button'
            ));
            return !btns.some((b) => {
              const r = b.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
          },
          { timeout: 20000 },
        )
        .catch(() => this._logger.warn('Timeout aguardando restore sumir — continuando...'));
      await this._spotfire.waitForIdle();
    }

    // Aguarda o relatório estar pronto após restaurar o layout
    await this._spotfire.waitForIdle();
  }

  /**
   * Se existir uma visualização maximizada diferente da tabela Deslocamentos,
   * restaura o layout. Caso a própria tabela já esteja maximizada, não faz nada.
   */
  async _restoreIfOtherVisualMaximized(page) {
    const shouldRestore = await page.evaluate((visualId) => {
      const our = document.querySelector(`[sf-visual-id="${visualId}"]`);
      const ourMax = !!our && our.classList.contains('sfpc-maximized');
      if (ourMax) return false;
      // Se existir qualquer botão de restore visível, alguma visual está maximizada.
      const btn = document.querySelector('[title="Restore visualization layout"].sfc-maximize-visual-button');
      if (!btn) return false;
      const r = btn.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }, TABLE_VISUAL_ID);

    if (shouldRestore) {
      await this._restoreTableIfMaximized(page);
    }
  }

  /**
   * Encontra o ID do HtmlTextAreaControl pelo texto do rótulo visível
   * (ex.: 'Área:', 'Base:', 'Disponibilidade:').
   *
   * Os IDs dos controles mudam a cada recarga da página, por isso a busca
   * é feita pelo texto do rótulo que fica antes do controle no DOM.
   *
   * @param {object} page
   * @param {string} labelText - texto exato do rótulo (ex.: 'Área:')
   * @returns {Promise<string|null>}
   */
  async _findControlByLabel(page, labelText) {
    const normalizeLabel = (s) =>
      (s || '')
        .toString()
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s*:\s*$/, '') // remove ':' final opcional
        .trim();

    const normalizedTarget = normalizeLabel(labelText);

    const id = await page.evaluate((targetLabel) => {
      const htacs = Array.from(document.querySelectorAll('.HtmlTextArea'));
      if (!htacs.length) return null;

      const normalizeLabel = (s) =>
        (s || '')
          .toString()
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/\s*:\s*$/, '')
          .trim();

      // Spotfire pode ter múltiplas HtmlTextArea. Varremos todas.
      for (const htac of htacs) {
        // 1. Procuramos elementos que contenham o texto do label
        const paragraphs = Array.from(htac.querySelectorAll('p, span, div, font, strong'));
        let labelElement = null;

        for (const p of paragraphs) {
          const text = normalizeLabel(p.textContent);
          // Aceita "Base" vs "Base:" e também casos em que o elemento contém mais texto.
          if (text === targetLabel || text.startsWith(targetLabel)) {
            labelElement = p;
            break;
          }
        }

        if (!labelElement) continue;

        // 2. Todos os controles com itens de lista, na ordem em que aparecem no DOM
        const controls = [...htac.querySelectorAll('.HtmlTextAreaControl')]
          .filter((el) => el.querySelector('.sf-element-list-box-item'));

        // 3. Retornamos o primeiro controle que venha DEPOIS do nosso elemento do label
        for (const ctrl of controls) {
          if (labelElement.compareDocumentPosition(ctrl) & Node.DOCUMENT_POSITION_FOLLOWING) {
            return ctrl.id;
          }
        }
      }

      return null;
    }, normalizedTarget);

    if (!id) this._logger.warn(`[htac] Rótulo "${labelText}" não encontrado no DOM`);
    return id;
  }

  /**
   * Clica num item do filtro HtmlTextAreaControl identificado pelo rótulo visível.
   *
   * Fluxo:
   *  1. Localiza o controle pelo texto do rótulo (runtime — IDs mudam por recarga)
   *  2. Verifica se o item já está selecionado (sfpc-selected no próprio item)
   *  3. ElementHandle.click() via CDP — bypassa overflow:hidden
   *  4. Fallback: disparo sintético de MouseEvents
   *
   * @param {object} page
   * @param {string} labelText - rótulo do filtro (ex.: 'Área:', 'Base:')
   * @param {string} itemTitle - valor do atributo title do item a clicar
   * @returns {Promise<boolean>}
   */
  async _clickHtacItem(page, labelText, itemTitle, { forceToggle = false, controlId: preferredControlId = null } = {}) {
    this._logger.info(`[htac "${labelText}"] clicando "${itemTitle}"...`);

    let controlId = preferredControlId;
    if (!controlId) {
      controlId = await this._findControlByLabel(page, labelText);
    }
    if (!controlId) {
      const recovered = await this._recoverFiltersPanel(page);
      if (recovered) {
        controlId = await this._findControlByLabel(page, labelText);
      }
      // Fallback: para filtros críticos, tenta localizar o controle pelos itens.
      if (!controlId) {
        if (labelText === HTAC_LABELS.base) controlId = await this._findBaseControlId(page);
        if (labelText === HTAC_LABELS.area) controlId = await this._findAreaControlId(page);
        if (labelText === HTAC_LABELS.disponibilidade) controlId = await this._findDisponibilidadeControlId(page);
      }
      if (!controlId) {
        this._logger.warn(`[htac] Controle "${labelText}" não localizado — pulando`);
        return false;
      }
    }

    // ── 1. Item já selecionado? ──
    const alreadySelected = await page.evaluate((id, title) => {
      const ctrl = document.getElementById(id);
      if (!ctrl) return false;
      const item = ctrl.querySelector(`.sf-element-list-box-item[title="${title}"]`);
      return item ? item.classList.contains('sfpc-selected') : false;
    }, controlId, itemTitle);

    if (alreadySelected && !forceToggle) {
      this._logger.info(`[htac] "${itemTitle}" já selecionado`);
      return true;
    }

    // ── 2. Obtém ElementHandle pelo atributo title ──
    const handle = await page.evaluateHandle((id, title) => {
      const ctrl = document.getElementById(id);
      if (!ctrl) return null;
      return ctrl.querySelector(`.sf-element-list-box-item[title="${title}"]`) ?? null;
    }, controlId, itemTitle);

    const el = handle.asElement();
    if (!el) {
      // Debug: exibe títulos disponíveis no controle
      await page.evaluate((id, label) => {
        const ctrl = document.getElementById(id);
        if (!ctrl) { console.log(`[NorthRadar] controle "${label}" (id:${id.slice(0, 8)}) não encontrado`); return; }
        const titles = [...ctrl.querySelectorAll('.sf-element-list-box-item')]
          .map((d) => `"${d.getAttribute('title')}"`);
        console.log(`[NorthRadar][htac "${label}"] títulos disponíveis: ${titles.join(', ')}`);
      }, controlId, labelText);
      this._logger.warn(`[htac] "${itemTitle}" não encontrado em "${labelText}"`);
      return false;
    }

    // ── 3. ElementHandle.click() — CDP faz scroll automático (bypassa overflow:hidden) ──
    try {
      await el.click();
      await new Promise((r) => setTimeout(r, 500));
      this._logger.info(`[htac] "${itemTitle}" clicado via CDP`);
      return true;
    } catch (e) {
      this._logger.warn(`[htac] CDP click falhou (${e.message}) — tentando sintético`);
    }

    // ── 4. Fallback: MouseEvent sintético ──
    const dispatched = await page.evaluate((id, title) => {
      const ctrl = document.getElementById(id);
      if (!ctrl) return false;
      const item = ctrl.querySelector(`.sf-element-list-box-item[title="${title}"]`);
      if (!item) return false;
      for (const t of ['mousedown', 'mouseup', 'click']) {
        item.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    }, controlId, itemTitle);

    await new Promise((r) => setTimeout(r, 500));
    if (dispatched) this._logger.info(`[htac] "${itemTitle}" clicado (sintético)`);
    else this._logger.warn(`[htac] "${itemTitle}" não foi possível clicar`);
    return dispatched;
  }

  /**
   * Clica no item "(All)" de um filtro do HtmlTextAreaControl.
   * Não depende do número de valores (ex.: "(All) 3 values"), apenas do prefixo.
   */
  async _clickHtacAll(page, labelText) {
    this._logger.info(`[htac "${labelText}"] clicando "(All)"...`);

    // A lista pode ser virtualizada; por isso aplicamos retry + fallback.
    // Critério: encontrar qualquer item cujo title/text começa com "(All)".
    const MAX_ATTEMPTS = 6;
    let lastControlId = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this._waitForFiltersReady(page).catch(() => {});

      let controlId = await this._findControlByLabel(page, labelText);
      if (!controlId) {
        const recovered = await this._recoverFiltersPanel(page);
        if (recovered) {
          controlId = await this._findControlByLabel(page, labelText);
        }
      }

      // Fallback para Base: identificar pelo item (All) 3 values/valores
      if (!controlId && labelText === HTAC_LABELS.base) {
        controlId = await this._findBaseControlId(page);
      }

      if (!controlId) {
        this._logger.warn(`[htac] Controle "${labelText}" não localizado — retry ${attempt}/${MAX_ATTEMPTS}`);
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }

      lastControlId = controlId;

      const alreadySelected = await page.evaluate((id) => {
        const ctrl = document.getElementById(id);
        if (!ctrl) return false;
        const item = [...ctrl.querySelectorAll('.sf-element-list-box-item')]
          .find((el) => {
            const t = (el.getAttribute('title') || '').trim();
            const txt = (el.textContent || '').trim();
            return t.startsWith('(All)') || txt.startsWith('(All)');
          });
        return item ? item.classList.contains('sfpc-selected') : false;
      }, controlId);

      if (alreadySelected) {
        this._logger.info('[htac] "(All)" já selecionado');
        return true;
      }

      // 1) Tenta dentro do controle resolvido
      let handle = await page.evaluateHandle((id) => {
        const ctrl = document.getElementById(id);
        if (!ctrl) return null;
        const items = [...ctrl.querySelectorAll('.sf-element-list-box-item')];
        const norm = (s) => (s || '').toString().replace(/\u00a0/g, ' ').trim().toLowerCase();
        // Preferência: "(All) 3 values/valores" se estiver visível
        const preferred = items.find((el) => {
          const v = norm(el.getAttribute('title') || el.textContent || '');
          return v.startsWith('(all)') && /(^|\s)3(\s|$)/.test(v) && /(value|values|valor|valores)/.test(v);
        });
        if (preferred) return preferred;
        return items.find((el) => {
          const v = norm(el.getAttribute('title') || el.textContent || '');
          return v.startsWith('(all)');
        }) ?? null;
      }, controlId);

      let el = handle.asElement();
      if (!el && labelText === HTAC_LABELS.base) {
        // 2) Fallback global (SEGURO): só pega (All) que pertença ao controle Base.
        // Base costuma ter "(All) 3 values/valores" e/ou itens ATLÂNTICO/CENTRO-NORTE.
        handle = await page.evaluateHandle(() => {
          const items = Array.from(document.querySelectorAll('.sf-element-list-box-item'));
          const norm = (s) => (s || '').toString().replace(/\u00a0/g, ' ').trim().toLowerCase();
          const visible = (node) => {
            const r = node.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const candidates = items.filter((it) => {
            if (!visible(it)) return false;
            const v = norm(it.getAttribute('title') || it.textContent || '');
            return v.startsWith('(all)');
          });

          const isAll3 = (v) => /(^|\s)3(\s|$)/.test(v) && /(value|values|valor|valores)/.test(v);

          const isBaseControl = (it) => {
            const ctrl = it.closest('.HtmlTextAreaControl');
            if (!ctrl) return false;
            const ctrlItems = Array.from(ctrl.querySelectorAll('.sf-element-list-box-item'));
            const ctrlValues = ctrlItems.map((n) => norm(n.getAttribute('title') || n.textContent || ''));

            const hasAtlantico = ctrlValues.includes('atlântico') || ctrlValues.includes('atlantico');
            const hasCentro = ctrlValues.includes('centro-norte') || ctrlValues.includes('centro norte');
            const hasAll3 = ctrlValues.some((v) => v.startsWith('(all)') && isAll3(v));

            return hasAll3 || hasAtlantico || hasCentro;
          };

          const baseCandidates = candidates.filter(isBaseControl);
          const preferred = baseCandidates.find((it) => {
            const v = norm(it.getAttribute('title') || it.textContent || '');
            return isAll3(v);
          });

          // IMPORTANT: não clicar em (All) genérico de outros filtros.
          return preferred || baseCandidates[0] || null;
        });
        el = handle.asElement();
      }

      if (!el) {
        await page.evaluate((id, label) => {
          const ctrl = document.getElementById(id);
          if (!ctrl) { console.log(`[NorthRadar][htac "${label}"] controle não encontrado (id=${id})`); return; }
          const vals = [...ctrl.querySelectorAll('.sf-element-list-box-item')]
            .map((d) => (d.getAttribute('title') || d.textContent || '').replace(/\u00a0/g, ' ').trim())
            .filter(Boolean);
          console.log(`[NorthRadar][htac "${label}"] itens visíveis: ${vals.join(' | ')}`);
        }, controlId, labelText);
        this._logger.warn(`[htac] Item "(All)" não encontrado em "${labelText}" — retry ${attempt}/${MAX_ATTEMPTS}`);
        await new Promise((r) => setTimeout(r, 650));
        continue;
      }

      try {
        await el.click();
        await new Promise((r) => setTimeout(r, 500));
        this._logger.info('[htac] "(All)" clicado via CDP');
        return true;
      } catch (e) {
        this._logger.warn(`[htac] CDP click falhou (${e.message}) — retry ${attempt}/${MAX_ATTEMPTS}`);
        await new Promise((r) => setTimeout(r, 650));
      }
    }

    // Se chegou aqui, falhou depois de vários retries
    if (lastControlId) {
      this._logger.warn(`[htac] Falha ao clicar (All) após retries (controlId=${lastControlId})`);
    }
    return false;
  }

  async _select_emServico(page) {
    this._logger.info('Selecionando "Em Serviço" em Disponibilidade:...');
    return await this._clickHtacItem(page, HTAC_LABELS.disponibilidade, 'Em Serviço');
  }

  async _select_area_norte(page) {
    this._logger.info('Selecionando "NORTE" em Área:...');
    return await this._clickHtacItem(page, HTAC_LABELS.area, 'NORTE');
  }

  async _selectBaseAll(page) {
    this._logger.info('Selecionando "(All)" em Base:...');

    // Se houver polos selecionados, desmarca antes para evitar multi-seleção residual.
    let baseCtrlId = await this._findControlByLabel(page, HTAC_LABELS.base);
    if (!baseCtrlId) {
      const recovered = await this._recoverFiltersPanel(page);
      if (recovered) baseCtrlId = await this._findControlByLabel(page, HTAC_LABELS.base);
    }
    if (!baseCtrlId) baseCtrlId = await this._findBaseControlId(page);

    if (baseCtrlId) {
      const selected = await page.evaluate((id) => {
        const ctrl = document.getElementById(id);
        if (!ctrl) return [];
        return [...ctrl.querySelectorAll('.sf-element-list-box-item.sfpc-selected')]
          .map((d) => (d.getAttribute('title') || d.textContent || '').replace(/\u00a0/g, ' ').trim())
          .filter((t) => t && !t.startsWith('(All)'));
      }, baseCtrlId);

      for (const title of selected) {
        this._logger.info(`[Base:] deselecionando "${title}" (pré-(All))`);
        await this._clickHtacItem(page, HTAC_LABELS.base, title, { forceToggle: true });
      }
    }

    const ok = await this._clickHtacAll(page, HTAC_LABELS.base);
    if (!ok) throw new Error('"(All)" não encontrado no filtro Base:');
    this._logger.info('Base: (All) selecionado');
  }

  async _selectPolo(page, polo) {
    const displayNames = POLO_DISPLAY[polo];
    if (!displayNames || !displayNames.length) throw new Error(`Polo não reconhecido: "${polo}"`);

    // Localiza o controle Base: em runtime (ID muda a cada recarga)
    let baseCtrlId = await this._findControlByLabel(page, HTAC_LABELS.base);
    if (!baseCtrlId) {
      // Filtro às vezes demora a aparecer no DOM (principalmente após restore/maximize).
      await this._waitForFiltersReady(page, { timeoutMs: 8000 });
      const recovered = await this._recoverFiltersPanel(page);
      if (recovered) {
        baseCtrlId = await this._findControlByLabel(page, HTAC_LABELS.base);
      }
    }

    if (!baseCtrlId) {
      baseCtrlId = await this._findBaseControlId(page);
    }

    let resolvedTitle = await this._resolveHtacTitle(page, baseCtrlId, displayNames);
    if (!resolvedTitle) {
      const fallbackMatch = await this._findBestBaseControlMatch(page, displayNames);
      if (fallbackMatch?.controlId && fallbackMatch?.resolvedTitle) {
        baseCtrlId = fallbackMatch.controlId;
        resolvedTitle = fallbackMatch.resolvedTitle;
      }
    }

    if (!resolvedTitle) {
      throw new Error(`Nenhum alias de "${polo}" encontrado no filtro Base: ${displayNames.join(', ')}`);
    }

    this._logger.info(`Selecionando polo "${resolvedTitle}" em Base:...`);

    if (baseCtrlId) {
      // Deseleciona todos os outros polos selecionados antes de selecionar o alvo
      const toDeselect = await page.evaluate((id, target) => {
        const ctrl = document.getElementById(id);
        if (!ctrl) return [];
        return [...ctrl.querySelectorAll('.sf-element-list-box-item.sfpc-selected')]
          .map((d) => d.getAttribute('title'))
          .filter((t) => t && t !== '(All) 3 values' && t !== target);
      }, baseCtrlId, resolvedTitle);

      for (const title of toDeselect) {
        this._logger.info(`[Base:] deselecionando "${title}"`);
        await this._clickHtacItem(page, HTAC_LABELS.base, title, { forceToggle: true, controlId: baseCtrlId });
      }
    }

    const found = await this._clickHtacItem(page, HTAC_LABELS.base, resolvedTitle, { controlId: baseCtrlId });
    if (!found) throw new Error(`"${resolvedTitle}" não encontrado no filtro Base:`);
    this._logger.info(`Polo ${polo} → "${resolvedTitle}" selecionado`);
  }

  async _resolveHtacTitle(page, controlId, candidates) {
    if (!controlId || !Array.isArray(candidates) || candidates.length === 0) return null;

    const titles = await this._getHtacTitles(page, controlId);

    if (!titles.length) return null;

    const normalizedTitles = titles.map((title) => ({ raw: title, normalized: normalizeFilterTitle(title) }));

    for (const candidate of candidates) {
      const normalizedCandidate = normalizeFilterTitle(candidate);
      const exact = normalizedTitles.find((item) => item.normalized === normalizedCandidate);
      if (exact) return exact.raw;
    }

    for (const candidate of candidates) {
      const normalizedCandidate = normalizeFilterTitle(candidate);
      const partial = normalizedTitles.find((item) => item.normalized.indexOf(normalizedCandidate) >= 0);
      if (partial) return partial.raw;
    }

    this._logger.warn(`[Base:] aliases não encontrados. Disponíveis: ${titles.join(', ')}`);
    return null;
  }

  async _getHtacTitles(page, controlId) {
    if (!controlId) return [];

    return page.evaluate((id) => {
      const ctrl = document.getElementById(id);
      if (!ctrl) return [];
      return [...ctrl.querySelectorAll('.sf-element-list-box-item')]
        .map((item) => item.getAttribute('title') || item.textContent || '')
        .filter(Boolean);
    }, controlId);
  }

  async _findBestBaseControlMatch(page, candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return null;

    const matches = await this._safeEvaluate(page, (rawCandidates) => {
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();

      const candidateEntries = rawCandidates.map((candidate) => ({
        raw: candidate,
        normalized: normalize(candidate),
      }));

      const baseAliases = ['ATLANTICO', 'CENTRO-NORTE', 'CENTRO NORTE', 'NORTE', 'DNORT'];
      const controls = Array.from(document.querySelectorAll('.HtmlTextAreaControl'))
        .filter((el) => el.querySelector('.sf-element-list-box-item'));

      const scored = controls.map((ctrl) => {
        const titles = Array.from(ctrl.querySelectorAll('.sf-element-list-box-item'))
          .map((item) => item.getAttribute('title') || item.textContent || '')
          .filter(Boolean);
        const normalizedTitles = titles.map((title) => ({ raw: title, normalized: normalize(title) }));

        let resolvedTitle = null;
        let matchScore = 0;

        for (const candidate of candidateEntries) {
          const exact = normalizedTitles.find((item) => item.normalized === candidate.normalized);
          if (exact) {
            resolvedTitle = exact.raw;
            matchScore = 100;
            break;
          }
        }

        if (!resolvedTitle) {
          for (const candidate of candidateEntries) {
            const partial = normalizedTitles.find((item) => item.normalized.includes(candidate.normalized));
            if (partial) {
              resolvedTitle = partial.raw;
              matchScore = 50;
              break;
            }
          }
        }

        const hasAllThree = normalizedTitles.some((item) => item.normalized.startsWith('(ALL)')
          && /(^|\s)3(\s|$)/.test(item.normalized)
          && /(VALUE|VALUES|VALOR|VALORES)/.test(item.normalized));
        const aliasHits = baseAliases.reduce((total, alias) => (
          total + (normalizedTitles.some((item) => item.normalized === alias) ? 1 : 0)
        ), 0);

        return {
          controlId: ctrl.id || null,
          resolvedTitle,
          titles,
          score: matchScore + (hasAllThree ? 20 : 0) + aliasHits,
        };
      });

      scored.sort((left, right) => right.score - left.score);
      return scored;
    }, candidates);

    const best = Array.isArray(matches) ? matches.find((entry) => entry?.resolvedTitle && entry?.controlId) : null;
    if (!best) return null;

    this._logger.info(`[Base:] controle alternativo resolvido (${best.controlId}) para alias "${best.resolvedTitle}"`);
    return best;
  }

  async _expandTable(page) {
    // Se já estiver maximizada, não clicar em nada (mantém maximizada entre requests).
    const state = await page.evaluate((visualId) => {
      const visual = document.querySelector(`[sf-visual-id="${visualId}"]`);
      if (!visual) return { found: false, maximized: false, canMaximize: false };
      const maximized = visual.classList.contains('sfpc-maximized');
      const restoreBtn = visual.querySelector('[title="Restore visualization layout"].sfc-maximize-visual-button');
      if (restoreBtn) return { found: true, maximized: true, canMaximize: false };
      const maximizeBtn = visual.querySelector('[title="Maximize visualization"].sfc-maximize-visual-button');
      return { found: true, maximized, canMaximize: !!maximizeBtn };
    }, TABLE_VISUAL_ID);

    if (!state.found) {
      this._logger.warn('Visual "Deslocamentos" não encontrado — continuando');
      return;
    }

    if (state.maximized) {
      this._logger.info('Tabela "Deslocamentos" já está maximizada');
      return;
    }

    const clicked = await page.evaluate((visualId) => {
      const visual = document.querySelector(`[sf-visual-id="${visualId}"]`);
      if (!visual) return false;
      const btn = visual.querySelector('[title="Maximize visualization"].sfc-maximize-visual-button');
      if (!btn) return false;
      btn.click();
      return true;
    }, TABLE_VISUAL_ID);

    if (clicked) {
      await new Promise((r) => setTimeout(r, 1100));
      await this._spotfire.waitForIdle();
      this._logger.info('Tabela "Deslocamentos" maximizada');
      return;
    }

    this._logger.warn('Botão maximize de "Deslocamentos" não encontrado — continuando');
  }

  async _safeEvaluate(page, fn, ...args) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await page.evaluate(fn, ...args);
      } catch (err) {
        lastErr = err;
        const msg = (err && err.message) ? err.message : String(err);
        const transient = /Execution context was destroyed|Cannot find context|Target closed/i.test(msg);
        if (!transient) throw err;
        this._logger.warn(`evaluate falhou por recarga/navegação (${msg}) — retry ${attempt + 1}/4`);
        await new Promise((r) => setTimeout(r, 750));
        try { await this._spotfire.waitForIdle(); } catch (_) {}
      }
    }
    throw lastErr;
  }

  async _focusTableViewport(page) {
    // Importante: evitar clicar em célula/linha (seleciona linha).
    // Estratégia:
    //  1) tenta focus() programático no viewport
    //  2) se não funcionou, clica numa área segura: header (frozenRowsCanvas / column header)
    //     ou na coluna do scrollbar vertical.

    const focused = await this._safeEvaluate(page, (visualId) => {
      const visual = document.querySelector(`[sf-visual-id="${visualId}"]`);
      const vp = visual?.querySelector('.table-viewport');
      if (!vp) return false;
      if (vp.tabIndex < 0) vp.tabIndex = 0;
      vp.focus();
      return document.activeElement === vp || vp.contains(document.activeElement);
    }, TABLE_VISUAL_ID);

    if (focused) return true;

    const clickPos = await this._safeEvaluate(page, (visualId) => {
      const visual = document.querySelector(`[sf-visual-id="${visualId}"]`);
      if (!visual) return null;

      const header =
        visual.querySelector('.frozenRowsCanvas') ||
        visual.querySelector('.sfc-column-header') ||
        visual.querySelector('.VerticalScrollbarContainer');

      if (!header) return null;
      const r = header.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return null;

      // Clica no canto superior esquerdo do header/scrollbar (não em linha)
      return { x: r.left + Math.min(20, r.width / 2), y: r.top + Math.min(20, r.height / 2) };
    }, TABLE_VISUAL_ID);

    if (!clickPos) return false;
    await page.mouse.click(clickPos.x, clickPos.y);

    const focusedAfterClick = await this._safeEvaluate(page, (visualId) => {
      const visual = document.querySelector(`[sf-visual-id="${visualId}"]`);
      const vp = visual?.querySelector('.table-viewport');
      if (!vp) return false;
      return document.activeElement === vp || vp.contains(document.activeElement);
    }, TABLE_VISUAL_ID);

    return !!focusedAfterClick;
  }

  /**
   * Quando a visualização fica maximizada, o painel de filtros (HtmlTextArea)
   * pode não estar no DOM/visível. Este método tenta recuperar a UI para permitir
   * aplicar filtros, restaurando temporariamente o layout se necessário.
   *
   * Observação: o requisito é manter a tabela maximizada ENTRE requests; durante a
   * request podemos restaurar e re-maximizar se o Spotfire esconder os filtros.
   */
  async _recoverFiltersPanel(page) {
    // Se o nosso visual está maximizado, restaurar layout para expor filtros.
    const ourMaximized = await page.evaluate((visualId) => {
      const our = document.querySelector(`[sf-visual-id="${visualId}"]`);
      return !!our && our.classList.contains('sfpc-maximized');
    }, TABLE_VISUAL_ID);

    if (!ourMaximized) return false;

    const hasRestoreButton = await page.evaluate(() => {
      const btn = document.querySelector('[title="Restore visualization layout"].sfc-maximize-visual-button');
      if (!btn) return false;
      const r = btn.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });

    if (!hasRestoreButton) return false;

    this._logger.info('Painel de filtros não visível — restaurando layout temporariamente...');
    await this._restoreTableIfMaximized(page);
    await this._spotfire.waitForIdle();

    // Aguarda o HTAC aparecer
    for (let i = 0; i < 10; i++) {
      const ok = await page.evaluate(() => document.querySelectorAll('.HtmlTextArea').length > 0);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 300));
    }

    return false;
  }

  /**
   * Retorna métricas de scroll da tabela (scrollbar custom do Spotfire + transform da canvas).
   * Útil porque o .table-viewport nem sempre expõe scrollTop real.
   */
  async _getTableScrollMetrics(page) {
    return this._safeEvaluate(page, (visualId) => {
      const visual = document.querySelector(`[sf-visual-id="${visualId}"]`);
      if (!visual) {
        return {
          ok: false,
          handleTop: null,
          handleHeight: null,
          containerHeight: null,
          atBottom: false,
          atTop: false,
          translateY: null,
          maxRow: null,
        };
      }

      const vScroll = visual.querySelector('.VerticalScrollbarContainer');
      const handle = vScroll?.querySelector('.ScrollbarHandle');

      const parsePx = (s) => {
        const n = parseFloat((s || '').toString().replace('px', ''));
        return Number.isFinite(n) ? n : null;
      };

      const cr = vScroll ? vScroll.getBoundingClientRect() : null;
      const hr = handle ? handle.getBoundingClientRect() : null;

      // Preferimos boundingClientRect (style.top pode vir vazio quando o layout usa transform)
      const containerHeight = cr ? cr.height : null;
      const handleHeight = hr ? hr.height : parsePx(handle?.style?.height);
      const handleTop = (cr && hr) ? (hr.top - cr.top) : parsePx(handle?.style?.top);

      // Transform translateY da canvas de células (proxy do offset)
      const canvas = visual.querySelector('.valueCellCanvas');
      const tf = canvas?.style?.transform || '';
      const m = tf.match(/translate\(\s*-?\d+(?:\.\d+)?px,\s*(-?\d+(?:\.\d+)?)px\s*\)/i);
      const translateY = m ? parseFloat(m[1]) : null;

      const cellEls = [...visual.querySelectorAll('.sfc-value-cell[row][column]')];
      const rows = cellEls
        .map((el) => parseInt(el.getAttribute('row')))
        .filter((r) => Number.isFinite(r));
      const maxRow = rows.length ? Math.max(...rows) : null;

      const atBottom =
        containerHeight != null && handleTop != null && handleHeight != null
          ? (handleTop + handleHeight) >= (containerHeight - 1)
          : false;
      const atTop = handleTop != null ? handleTop <= 1 : false;

      return {
        ok: true,
        handleTop,
        handleHeight,
        containerHeight,
        atBottom,
        atTop,
        translateY,
        maxRow,
      };
    }, TABLE_VISUAL_ID);
  }

  async _dragScrollbarHandle(page, { to = 'bottom', stepPx = 120 } = {}) {
    const rects = await this._safeEvaluate(page, (visualId) => {
      const visual = document.querySelector(`[sf-visual-id="${visualId}"]`);
      if (!visual) return null;
      const container = visual.querySelector('.VerticalScrollbarContainer');
      const handle = container?.querySelector('.ScrollbarHandle');
      if (!container || !handle) return null;

      const cr = container.getBoundingClientRect();
      const hr = handle.getBoundingClientRect();
      if (cr.width <= 0 || cr.height <= 0 || hr.width <= 0 || hr.height <= 0) return null;

      return {
        container: { left: cr.left, top: cr.top, width: cr.width, height: cr.height },
        handle: { left: hr.left, top: hr.top, width: hr.width, height: hr.height },
      };
    }, TABLE_VISUAL_ID);

    if (!rects) return false;

    const handleCenterX = rects.handle.left + rects.handle.width / 2;
    const handleCenterY = rects.handle.top + rects.handle.height / 2;

    let targetY;
    if (to === 'bottom') {
      targetY = rects.container.top + rects.container.height - rects.handle.height / 2 - 2;
    } else if (to === 'top') {
      targetY = rects.container.top + rects.handle.height / 2 + 2;
    } else {
      // step: move down by stepPx
      targetY = handleCenterY + stepPx;
      const minY = rects.container.top + rects.handle.height / 2 + 2;
      const maxY = rects.container.top + rects.container.height - rects.handle.height / 2 - 2;
      targetY = Math.max(minY, Math.min(maxY, targetY));
    }

    // Se já estamos praticamente na posição alvo, não faz drag (evita flicker/pisca).
    if (Math.abs(targetY - handleCenterY) < 1.5) return false;

    await page.mouse.move(handleCenterX, handleCenterY);
    await page.mouse.down();
    await page.mouse.move(handleCenterX, targetY, { steps: 12 });
    await page.mouse.up();
    return true;
  }

  /**
   * Rola a tabela até o fim (scroll bottom) antes de extrair.
   * Isso força o Spotfire a carregar mais páginas/linhas na renderização virtual.
   */
  async _scrollToEnd(page) {
    this._logger.info('Rolando tabela até o fim (pré-carregamento)...');

    await this._focusTableViewport(page);

    let stable = 0;
    const MAX_STABLE = 8;
    const MAX_ITERS = 180;

    let last = await this._getTableScrollMetrics(page);

    for (let i = 0; i < MAX_ITERS; i++) {
      if (last.ok && last.atBottom) {
        stable++;
        if (stable >= 2) break;
      }

      // PageDown (conforme solicitado) — sem wheel
      await this._focusTableViewport(page);
      await page.keyboard.press('PageDown');
      if (stable >= 3) {
        // Fallback: Ctrl+End quando PageDown não avança
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
      }

      await new Promise((r) => setTimeout(r, 350));
      await this._spotfire.waitForIdle();

      const now = await this._getTableScrollMetrics(page);
      const changed =
        (now.handleTop != null && now.handleTop !== last.handleTop) ||
        (now.translateY != null && now.translateY !== last.translateY) ||
        (now.maxRow != null && now.maxRow !== last.maxRow);

      if (!changed) stable++;
      else stable = 0;

      last = now;

      // Fallback máximo: arrastar a alça do scrollbar para o bottom se estiver "travado".
      if (stable >= 5 && (!now.ok || !now.atBottom)) {
        const dragged = await this._dragScrollbarHandle(page, { to: 'bottom' });
        if (dragged) {
          await new Promise((r) => setTimeout(r, 450));
          await this._spotfire.waitForIdle();
          stable = 0;
          last = await this._getTableScrollMetrics(page);
        }
      }

      if (stable >= MAX_STABLE) break;
    }

    this._logger.info('Pré-scroll concluído');
  }

  // ── Extração de dados ────────────────────────────────────────────

  /**
   * Rola a tabela progressivamente e coleta todas as linhas únicas.
   * @returns {Promise<string[][]>}
   */
  /**
   * Extrai todas as linhas da tabela Deslocamentos rolando com PageDown.
   *
   * A tabela usa renderização virtual: as células têm atributos `row` e `column`,
   * e só as linhas visíveis estão no DOM. Rola via PageDown no .table-viewport
   * até estabilizar (MAX_STABLE rounds sem novas linhas).
   */
  async _scrollAndExtract(page) {
    this._logger.info('Iniciando extração da tabela Deslocamentos...');

    await this._focusTableViewport(page);

    // Rola para o topo antes de começar (preferir drag no scrollbar; fallback PageUp/Ctrl+Home)
    const draggedTop = await this._dragScrollbarHandle(page, { to: 'top' });
    if (!draggedTop) {
      await this._focusTableViewport(page);
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('PageUp');
      }
      await page.keyboard.down('Control');
      await page.keyboard.press('Home');
      await page.keyboard.up('Control');
    }
    await new Promise((r) => setTimeout(r, 150));
    await this._waitWhileBusy(page, 2000);

    // A tabela pode virtualizar e reciclar índices de row. Para não perder linhas,
    // deduplicamos também por conteúdo da linha (string normalizada).
    const seenByRowNum = new Map();
    const seenByKey = new Map();

    // Spotfire exibe um status do tipo "106 of 423 rows" (ou "106 de 423 linhas").
    // Na prática, o primeiro número tende a ser o real (após filtros). Quando
    // atingimos essa contagem, podemos encerrar a captura sem depender só do scrollbar.
    // Importante: o indicador pode estar mostrando o valor do filtro anterior enquanto
    // o Spotfire ainda está atualizando. Então esperamos estabilizar antes de usar.
    let targetRowCount = await this._waitForDeslocamentosRowCountHintStable(page, {
      timeoutMs: 12000,
      stableReads: 3,
    });
    if (Number.isFinite(targetRowCount) && targetRowCount > 0) {
      this._logger.info(`Meta de linhas pelo indicador do Spotfire: ${targetRowCount}`);
    } else {
      targetRowCount = null;
    }
    let lastHintCheckAt = Date.now();
    const HINT_RECHECK_MS = 2500;

    let stableRounds = 0;
    const MAX_STABLE = 10;
    const MAX_ITERS = 250;

    // Evita ficar insistindo em "drag para bottom" quando o Spotfire já chegou ao fim
    // mas o DOM/medidas não confirmam (isso faz a barra piscar).
    let forcedBottomAttempts = 0;
    const MAX_FORCED_BOTTOM = 2;

    // Quando existe uma meta (X of Y rows) e ainda não atingimos X,
    // não podemos desistir só porque o scrollbar estabilizou — precisamos
    // tentar destravar a virtualização algumas vezes.
    let rescueAttempts = 0;
    const MAX_RESCUE = 4;

    let lastScrollTop = null;
    let lastMaxRow = null;
    let lastHandleTop = null;
    let lastTranslateY = null;

    for (let iter = 0; iter < MAX_ITERS && stableRounds < MAX_STABLE; iter++) {
      const snapshot = await this._safeEvaluate(page, (visualId) => {
        const visual = document.querySelector(`[sf-visual-id="${visualId}"]`);
        if (!visual) {
          return {
            rows: [],
            maxRow: null,
            handleTop: null,
            translateY: null,
            atBottom: false,
          };
        }

        // Métricas do scrollbar custom / canvas transform
        const vScroll = visual.querySelector('.VerticalScrollbarContainer');
        const handle = vScroll?.querySelector('.ScrollbarHandle');
        const parsePx = (s) => {
          const n = parseFloat((s || '').toString().replace('px', ''));
          return Number.isFinite(n) ? n : null;
        };
        const cr = vScroll ? vScroll.getBoundingClientRect() : null;
        const hr = handle ? handle.getBoundingClientRect() : null;
        const containerHeight = cr ? cr.height : null;
        const handleHeight = hr ? hr.height : parsePx(handle?.style?.height);
        const handleTop = (cr && hr) ? (hr.top - cr.top) : parsePx(handle?.style?.top);
        const atBottom =
          containerHeight != null && handleTop != null && handleHeight != null
            ? (handleTop + handleHeight) >= (containerHeight - 1)
            : false;

        const canvas = visual.querySelector('.valueCellCanvas');
        const tf = canvas?.style?.transform || '';
        const m = tf.match(/translate\(\s*-?\d+(?:\.\d+)?px,\s*(-?\d+(?:\.\d+)?)px\s*\)/i);
        const translateY = m ? parseFloat(m[1]) : null;

        const cellEls = [...visual.querySelectorAll('.sfc-value-cell[row][column]')];
        const rowMap = new Map();
        for (const el of cellEls) {
          const r = parseInt(el.getAttribute('row'));
          const c = parseInt(el.getAttribute('column'));
          if (isNaN(r) || isNaN(c)) continue;
          if (!rowMap.has(r)) rowMap.set(r, new Map());
          rowMap.get(r).set(c, el.querySelector('.cell-text')?.innerText?.trim() ?? '');
        }

        const rows = [...rowMap.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([rowNum, colMap]) => {
            const maxCol = Math.max(...colMap.keys());
            const cells = [];
            for (let c = 0; c <= maxCol; c++) cells.push(colMap.get(c) ?? '');
            return { rowNum, cells };
          });

        const maxRow = rows.length ? Math.max(...rows.map((r) => r.rowNum)) : null;
        return { rows, maxRow, handleTop, translateY, atBottom };
      }, TABLE_VISUAL_ID);

      const beforeKeys = seenByKey.size;
      const beforeRows = seenByRowNum.size;

      for (const { rowNum, cells } of snapshot.rows) {
        seenByRowNum.set(rowNum, cells);
        const key = cells
          .map((v) => (v ?? '').toString().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim())
          .join(' | ');
        if (key) seenByKey.set(key, cells);
      }

      const progressKeys = seenByKey.size > beforeKeys;
      const progressRows = seenByRowNum.size > beforeRows;

      // Se o indicador estiver disponível, paramos assim que atingirmos a contagem.
      // Usamos o maior dos dois dedupes como referência (rowNum ou conteúdo).
      const uniqueCount = Math.max(seenByRowNum.size, seenByKey.size);
      if (targetRowCount != null && uniqueCount >= targetRowCount) {
        this._logger.info(`Indicador Spotfire atingido: ${uniqueCount}/${targetRowCount} — encerrando loop.`);
        break;
      }

      // Revalida o indicador de tempos em tempos.
      // Isso resolve o caso em que a primeira leitura ainda estava com valor do filtro anterior.
      if ((Date.now() - lastHintCheckAt) >= HINT_RECHECK_MS) {
        lastHintCheckAt = Date.now();
        const hint = await this._getDeslocamentosRowCountHint(page);
        if (Number.isFinite(hint) && hint > 0) {
          // Só atualiza quando faz sentido para o fluxo atual.
          // - Não reduz abaixo do que já capturamos.
          // - Evita thrash quando o indicador oscila.
          const canUpdate = hint >= uniqueCount;
          const changed = targetRowCount == null || hint !== targetRowCount;
          if (changed && canUpdate) {
            targetRowCount = hint;
            this._logger.info(`Meta de linhas (atualizada) pelo indicador do Spotfire: ${targetRowCount}`);
            if (uniqueCount >= targetRowCount) {
              this._logger.info(`Indicador Spotfire atingido: ${uniqueCount}/${targetRowCount} — encerrando loop.`);
              break;
            }
          }
        }
      }

      const handleMoved =
        snapshot.handleTop != null &&
        lastHandleTop != null &&
        snapshot.handleTop !== lastHandleTop;

      const translateMoved =
        snapshot.translateY != null &&
        lastTranslateY != null &&
        snapshot.translateY !== lastTranslateY;

      const maxRowMoved =
        snapshot.maxRow != null &&
        lastMaxRow != null &&
        snapshot.maxRow !== lastMaxRow;

      // Critério de estabilidade: nada novo por conteúdo e nenhuma evidência de scroll/progresso.
      if (!progressKeys && !progressRows && !handleMoved && !translateMoved && !maxRowMoved) {
        stableRounds++;
      } else {
        stableRounds = 0;
        if (progressRows) this._logger.info(`  Linhas únicas (por índice): ${seenByRowNum.size}`);
      }

      lastMaxRow = snapshot.maxRow;
      lastHandleTop = snapshot.handleTop;
      lastTranslateY = snapshot.translateY;

      // Se já estamos no fim e estabilizou, podemos encerrar mais cedo.
      if (snapshot.atBottom && stableRounds >= 2) break;

      // Se estabilizou mas ainda não está no bottom, forçamos um salto pro fim uma vez.
      if (!snapshot.atBottom && stableRounds >= 6) {
        // Se temos meta e ainda não batemos nela, tenta destravar e continuar.
        if (targetRowCount != null && uniqueCount < targetRowCount) {
          if (rescueAttempts >= MAX_RESCUE) {
            this._logger.warn(`  Estável em ${uniqueCount}/${targetRowCount} e não avança; limite de resgate atingido — encerrando.`);
            break;
          }

          rescueAttempts++;
          const missing = targetRowCount - uniqueCount;

          // ── Estratégias de resgate escalonadas ───────────────────────────
          // Resgate 1: scan rápido — retrocede ~3 páginas e avança linha a linha.
          //            Resolve gaps próximos ao fim (caso mais comum).
          // Resgate 2+: scan completo desde o topo (Ctrl+Home → ArrowDown × total).
          //             Garante que todo índice virtualizado passe pelo viewport,
          //             independente de onde o gap esteja.
          const fullScan = rescueAttempts >= 2;
          this._logger.warn(
            `  Estável em ${uniqueCount}/${targetRowCount} — resgate ${rescueAttempts}/${MAX_RESCUE}: ` +
            `${fullScan ? 'varredura completa do topo' : 'modo linha a linha'} (${missing} faltando)...`,
          );

          await this._focusTableViewport(page);

          if (fullScan) {
            // Vai ao topo absoluto para garantir cobertura total
            await page.keyboard.down('Control');
            await page.keyboard.press('Home');
            await page.keyboard.up('Control');
            await this._waitWhileBusy(page, 2000);
          } else {
            // Retrocede ~3 páginas para cobrir gap próximo ao fim
            for (let pu = 0; pu < 3; pu++) {
              await page.keyboard.press('PageUp');
              await new Promise((r) => setTimeout(r, 60));
            }
            await this._waitWhileBusy(page, 2000);
          }

          // Número de ArrowDown:
          // - Scan completo: percorre todas as linhas esperadas com margem de 20%.
          // - Scan parcial:  cobre as linhas faltando com ampla margem de 4×.
          const arrowCount = fullScan
            ? Math.ceil(targetRowCount * 1.2)
            : Math.max(80, missing * 4 + 40);

          for (let k = 0; k < arrowCount; k++) {
            await page.keyboard.press('ArrowDown');

            // Captura a cada 8 teclas para não sobrecarregar o CDP
            if (k % 8 === 0) {
              const arrowSnap = await this._safeEvaluate(page, (visualId) => {
                const visual = document.querySelector(`[sf-visual-id="${visualId}"]`);
                if (!visual) return [];
                const rowMap = new Map();
                for (const el of visual.querySelectorAll('.sfc-value-cell[row][column]')) {
                  const r = parseInt(el.getAttribute('row'));
                  const c = parseInt(el.getAttribute('column'));
                  if (isNaN(r) || isNaN(c)) continue;
                  if (!rowMap.has(r)) rowMap.set(r, new Map());
                  rowMap.get(r).set(c, el.querySelector('.cell-text')?.innerText?.trim() ?? '');
                }
                return [...rowMap.entries()]
                  .sort((a, b) => a[0] - b[0])
                  .map(([rowNum, colMap]) => {
                    const maxCol = Math.max(...colMap.keys());
                    const cells = [];
                    for (let c = 0; c <= maxCol; c++) cells.push(colMap.get(c) ?? '');
                    return { rowNum, cells };
                  });
              }, TABLE_VISUAL_ID);

              for (const { rowNum, cells } of (arrowSnap || [])) {
                seenByRowNum.set(rowNum, cells);
                const key = cells
                  .map((v) => (v ?? '').toString().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim())
                  .join(' | ');
                if (key) seenByKey.set(key, cells);
              }

              const uc2 = Math.max(seenByRowNum.size, seenByKey.size);
              if (targetRowCount != null && uc2 >= targetRowCount) {
                this._logger.info(`  [resgate ${rescueAttempts}] Meta atingida durante ArrowDown: ${uc2}/${targetRowCount}`);
                break;
              }
            }

            await new Promise((r) => setTimeout(r, 28));
          }

          await this._waitWhileBusy(page, 2000);
          stableRounds = 0;
          forcedBottomAttempts = 0;
          continue;
        }

        if (forcedBottomAttempts >= MAX_FORCED_BOTTOM) {
          this._logger.warn('  Scroll estabilizou sem progresso; limite de tentativas de bottom atingido — encerrando para evitar loop.');
          break;
        }

        this._logger.info('  Scroll estabilizou sem chegar no fim — forçando drag para o bottom...');
        const dragged = await this._dragScrollbarHandle(page, { to: 'bottom' });
        forcedBottomAttempts++;

        // Se não houve movimento, não adianta insistir (evita piscar indefinidamente)
        if (!dragged) {
          this._logger.warn('  Drag para bottom não moveu a alça — encerrando para evitar loop.');
          break;
        }

        stableRounds = 0;
        await new Promise((r) => setTimeout(r, 120));
        await this._waitWhileBusy(page, 3000);
        continue;
      }

      // PageDown no viewport da tabela; se estiver "preso", tenta Ctrl+End + wheel.
      await this._focusTableViewport(page);
      await page.keyboard.press('PageDown');
      if (stableRounds >= 2) {
        // Fallback mais forte e mais cedo: drag step no scrollbar quando PageDown não avança
        if (!snapshot.atBottom) {
          const dragged = await this._dragScrollbarHandle(page, { to: 'step', stepPx: 220 });
          if (dragged) {
            await new Promise((r) => setTimeout(r, 120));
          }
        }
      }

      if (stableRounds >= 4) {
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
      }

      // Espera bem curta para a UI renderizar; se estiver busy, aguarda um pouco.
      await new Promise((r) => setTimeout(r, stableRounds ? 120 : 60));
      await this._waitWhileBusy(page, 1800);
    }

    // Preferimos por índice de linha quando ele avança (mantém duplicatas reais).
    // Se o Spotfire reciclar `row`, o fallback por conteúdo evita retornar vazio.
    const byRowNum = [...seenByRowNum.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, cells]) => cells);
    const byContent = [...seenByKey.values()];

    const result = byRowNum.length >= byContent.length ? byRowNum : byContent;
    this._logger.info(`Extração concluída: ${result.length} linhas (rowIdx=${byRowNum.length}, contentKey=${byContent.length})`);
    return result;
  }

  async _waitForDeslocamentosRowCountHintStable(page, { timeoutMs = 12000, stableReads = 3 } = {}) {
    const start = Date.now();

    // 1) Aguarda busy sumir (se estiver carregando)
    // (não falha se o busy nunca aparecer — apenas segue)
    await this._waitWhileBusy(page, Math.min(6000, timeoutMs));

    // 2) Coleta o indicador até estabilizar (mesmo valor N vezes seguidas)
    let last = null;
    let stable = 0;

    while ((Date.now() - start) < timeoutMs) {
      // Se ficou busy de novo, reseta estabilidade e espera.
      const isBusy = await this._safeEvaluate(page, () => !!document.querySelector('.sf-busy'));
      if (isBusy) {
        stable = 0;
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }

      const hint = await this._getDeslocamentosRowCountHint(page);

      if (Number.isFinite(hint) && hint > 0) {
        if (last === hint) stable++;
        else {
          last = hint;
          stable = 1;
        }

        if (stable >= stableReads) return hint;
      } else {
        // Sem hint ainda — aguarda um pouco.
        stable = 0;
      }

      await new Promise((r) => setTimeout(r, 250));
    }

    return last;
  }

  async _getDeslocamentosRowCountHint(page) {
    // Exemplo: "106 of 423 rows" (o 2º número pode ser inconsistente; o 1º é o alvo real)
    // Também aceita: "106 de 423 linhas"
    return await this._safeEvaluate(page, (visualId) => {
      const visual = document.querySelector(`[sf-visual-id="${visualId}"]`);
      if (!visual) return null;

      const parseHint = (txt) => {
        const t = (txt || '')
          .toString()
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!t) return null;

        const m = t.match(/([\d.,]+)\s*(?:of|de)\s*[\d.,]+\s*(?:rows|linhas)\b/i);
        if (!m) return null;
        const n = parseInt((m[1] || '').replace(/\D/g, ''), 10);
        return Number.isFinite(n) ? n : null;
      };

      // Caminho rápido: Spotfire costuma renderizar este status como um label
      // com classe "sfx_label_<n>" (o número muda, mas o prefixo é estável).
      const fastCandidates = Array.from(
        visual.querySelectorAll('[class^="sfx_label_"], [class*=" sfx_label_"]'),
      );
      for (const el of fastCandidates) {
        const hint = parseHint(el?.textContent);
        if (hint != null) return hint;
      }

      // Fallback: procura textos curtos em div/span fora das células da tabela.
      // (Evita varrer DOM de todas as células/linhas, que é enorme.)
      const els = Array.from(visual.querySelectorAll('div, span'));
      for (const el of els) {
        if (!el) continue;
        if (el.closest('.sfc-value-cell')) continue;
        if (el.classList?.contains('cell-text')) continue;
        const txt = el.textContent;
        if (!txt) continue;
        if (txt.length > 80) continue;
        const hint = parseHint(txt);
        if (hint != null) return hint;
      }

      // Fallback global: em alguns layouts o Spotfire renderiza os status-labels
      // fora da subtree do visual. Nesse caso, pegamos o label mais próximo (por retângulo)
      // da área do visual.
      const vr = visual.getBoundingClientRect();
      const containsPoint = (rect, x, y) => {
        if (!rect) return false;
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      };
      const nearVisual = (rect) => {
        if (!rect) return false;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        // Permite uma margem porque labels podem ficar um pouco fora do visual.
        const margin = 60;
        return (
          cx >= (vr.left - margin) && cx <= (vr.right + margin) &&
          cy >= (vr.top - margin) && cy <= (vr.bottom + margin)
        );
      };

      // Preferir containers de status (mais barato e mais específico).
      const statusContainers = Array.from(
        document.querySelectorAll('[class^="sfx_status-labels_"], [class*=" sfx_status-labels_"]'),
      );
      for (const container of statusContainers) {
        const cr = container?.getBoundingClientRect?.();
        if (!cr) continue;
        if (!nearVisual(cr)) continue;
        const hint = parseHint(container.textContent);
        if (hint != null) return hint;
      }

      // Último fallback: labels soltos próximos ao visual.
      const globalLabels = Array.from(
        document.querySelectorAll('[class^="sfx_label_"], [class*=" sfx_label_"]'),
      );
      for (const el of globalLabels) {
        const r = el?.getBoundingClientRect?.();
        if (!r) continue;
        // Precisa estar dentro ou muito perto do visual
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (!containsPoint(vr, cx, cy) && !nearVisual(r)) continue;
        const hint = parseHint(el.textContent);
        if (hint != null) return hint;
      }

      return null;
    }, TABLE_VISUAL_ID);
  }

  async _waitWhileBusy(page, timeoutMs = 1500) {
    const isBusy = await this._safeEvaluate(page, () => !!document.querySelector('.sf-busy'));
    if (!isBusy) return false;

    await page
      .waitForFunction(() => !document.querySelector('.sf-busy'), { timeout: timeoutMs })
      .catch(() => {});
    return true;
  }

  async _waitForFiltersReady(page, { timeoutMs = 25000 } = {}) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const ok = await this._safeEvaluate(page, () => {
        const htacs = document.querySelectorAll('.HtmlTextArea');
        if (!htacs.length) return false;

        // Verifica que os itens dos filtros já estão populados:
        // pelo menos um controle deve ter 3+ itens (Base: tem ATLÂNTICO, CENTRO-NORTE, NORTE)
        // e outro deve conter um dos valores esperados de Disponibilidade ou Área.
        const controls = Array.from(
          document.querySelectorAll('.HtmlTextAreaControl .sf-element-list-box-item'),
        );
        if (controls.length < 3) return false;

        const titles = controls.map(
          (el) => (el.getAttribute('title') || el.textContent || '').replace(/\u00a0/g, ' ').trim(),
        );
        const hasServico = titles.some((t) => t.includes('Em Servi'));
        const hasNorte   = titles.some((t) => t === 'NORTE');
        // Aceita qualquer indício de que os filtros chave já estão presentes
        return hasServico || hasNorte;
      });
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 350));
    }

    this._logger.warn('Timeout aguardando filtros HTAC aparecerem — continuando...');
    return false;
  }

  async _findBaseControlId(page) {
    // Base costuma conter o item "(All) 3 values" (3 polos). A lista pode ser virtualizada,
    // então nem sempre veremos ATLÂNTICO/CENTRO-NORTE/NORTE no DOM.
    return await this._safeEvaluate(page, () => {
      const controls = Array.from(document.querySelectorAll('.HtmlTextAreaControl'))
        .filter((el) => el.querySelector('.sf-element-list-box-item'));

      const normalize = (s) => (s || '')
        .toString()
        .replace(/\u00a0/g, ' ')
        .trim()
        .toLowerCase();

      // 1) Melhor heurística: existe item (All) com "3 values" (ou "3 valores")
      for (const ctrl of controls) {
        const items = Array.from(ctrl.querySelectorAll('.sf-element-list-box-item'));
        for (const it of items) {
          const raw = (it.getAttribute('title') || it.textContent || '');
          const v = normalize(raw);
          if (!v.startsWith('(all)')) continue;
          // aceita: "(All) 3 values", "(All) 3 value", "(All) 3 valores"
          if (/(^|\s)3(\s|$)/.test(v) && /(value|values|valor|valores)/.test(v)) {
            return ctrl.id || null;
          }
        }
      }

      for (const ctrl of controls) {
        const values = Array.from(ctrl.querySelectorAll('.sf-element-list-box-item'))
          .map((d) => ((d.getAttribute('title') || d.textContent || '')).replace(/\u00a0/g, ' ').trim());
        const hasAtlantico = values.includes('ATLÂNTICO') || values.includes('ATLANTICO');
        const hasCentro = values.includes('CENTRO-NORTE') || values.includes('CENTRO NORTE');
        const hasNorte = values.includes('NORTE');
        const hasAll = values.some((t) => t.startsWith('(All)'));
        const score = (hasAtlantico ? 1 : 0) + (hasCentro ? 1 : 0) + (hasNorte ? 1 : 0) + (hasAll ? 1 : 0);
        if (score >= 2) return ctrl.id || null;
      }

      return null;
    });
  }

  async _findAreaControlId(page) {
    // Área: deve ter NORTE, mas NÃO deve ter ATLÂNTICO/CENTRO-NORTE (que indicaria Base).
    return await this._safeEvaluate(page, () => {
      const controls = Array.from(document.querySelectorAll('.HtmlTextAreaControl'))
        .filter((el) => el.querySelector('.sf-element-list-box-item'));

      for (const ctrl of controls) {
        const values = Array.from(ctrl.querySelectorAll('.sf-element-list-box-item'))
          .map((d) => ((d.getAttribute('title') || d.textContent || '')).replace(/\u00a0/g, ' ').trim());
        const hasNorte = values.includes('NORTE');
        const looksLikeBase =
          values.includes('ATLÂNTICO') || values.includes('ATLANTICO') ||
          values.includes('CENTRO-NORTE') || values.includes('CENTRO NORTE');
        if (hasNorte && !looksLikeBase) return ctrl.id || null;
      }

      return null;
    });
  }

  async _findDisponibilidadeControlId(page) {
    // Disponibilidade: item "Em Serviço".
    return await this._safeEvaluate(page, () => {
      const controls = Array.from(document.querySelectorAll('.HtmlTextAreaControl'))
        .filter((el) => el.querySelector('.sf-element-list-box-item'));

      for (const ctrl of controls) {
        const values = Array.from(ctrl.querySelectorAll('.sf-element-list-box-item'))
          .map((d) => ((d.getAttribute('title') || d.textContent || '')).replace(/\u00a0/g, ' ').trim());
        if (values.includes('Em Serviço')) return ctrl.id || null;
      }

      return null;
    });
  }

  async _extractHeaders(page) {
    const headers = await page.evaluate((visualId) => {
      const visual = document.querySelector(`[sf-visual-id="${visualId}"]`);
      if (!visual) return [];
      // Cabeçalhos ficam em .frozenRowsCanvas com classe sfc-column-header
      return [...visual.querySelectorAll('.sfc-column-header[column]')]
        .sort((a, b) => parseInt(a.getAttribute('column')) - parseInt(b.getAttribute('column')))
        .map((h) => h.querySelector('.cell-text')?.innerText?.trim() ?? '')
        .filter(Boolean);
    }, TABLE_VISUAL_ID);

    if (headers.length > 0) {
      return headers.map((h) => this._normalizeHeaderKey(h));
    }

    return DEFAULT_HEADERS;
  }

  // ── Mapeamento de domínio ────────────────────────────────────────

  /**
   * Converte uma linha de células + array de chaves de colunas
   * num objeto Deslocamento.
   */
  _toDomain(cells, headers, polo) {
    const row = {};
    headers.forEach((key, i) => {
      row[key] = cells[i] ?? null;
    });

    return new Deslocamento({
      polo,
      dia:           row.dia           ?? row['Dia']           ?? null,
      equipe:        row.equipe        ?? row['Equipe']        ?? null,
      ordem:         row.ordem         ?? row['Ordem']         ?? null,
      despachado:    row.despachado    ?? row['Despachado']    ?? null,
      aCaminho:      row.aCaminho      ?? row['a_caminho']     ?? null,
      noLocal:       row.noLocal       ?? row['no_local']      ?? null,
      liberada:      row.liberada      ?? row['Liberada']      ?? null,
      inicioOs:      row.inicioOs      ?? row['inicio_os']     ?? null,
      fimOs:         row.fimOs         ?? row['fim_os']        ?? null,
      qtd:           row.qtd           ?? row['Qtd']                ?? row['qtd_deslocamentos']  ?? null,
      horas:         row.horas         ?? row['Horas']              ?? row['horas_trabalhadas']  ?? null,
      emAtendimento: row.emAtendimento ?? row['em_atendimento']     ?? null,
    });
  }

  /**
   * Normaliza um header do Spotfire para camelCase simples.
   * Ex.: "A Caminho" → "aCaminho", "Início OS" → "inicioOs"
   */
  _normalizeHeaderKey(header) {
    const MAP = {
      'Dia': 'dia', 'Equipe': 'equipe', 'Ordem': 'ordem',
      'Despachado': 'despachado', 'A Caminho': 'aCaminho', 'ACaminho': 'aCaminho',
      'No Local': 'noLocal', 'NoLocal': 'noLocal', 'no local': 'noLocal',
      'Liberada': 'liberada', 'liberada': 'liberada',
      'Início OS': 'inicioOs', 'InicioOS': 'inicioOs', 'Inicio OS': 'inicioOs',
      'Fim OS': 'fimOs', 'fimOs': 'fimOs', 'Fim Os': 'fimOs',
      'Qtd': 'qtd', 'Quantidade': 'qtd', 'Qtd Deslocamentos': 'qtd', 'Qtd deslocamentos': 'qtd',
      'Horas': 'horas', 'Horas Trabalhadas': 'horas', 'Horas trabalhadas': 'horas',
      'Em Atendimento': 'emAtendimento', 'Em atendimento': 'emAtendimento',
    };
    return MAP[header] ?? header.toLowerCase().replace(/\s+/g, '_');
  }
}

module.exports = DeslocamentoRepository;
