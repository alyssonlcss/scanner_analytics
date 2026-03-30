/**
 * DeslocamentoService
 *
 * Serviço que unifica:
 *   - Extração de deslocamentos por polo (via DeslocamentoRepository)
 *   - Cache em memória por polo
 *   - Scheduler de auto-refresh periódico
 *
 * A camada de server lê os dados daqui sem acionar o Spotfire
 * a cada request HTTP.
 */
const Logger = require('../../shared/Logger');

class DeslocamentoService {
  /**
   * @param {import('./DeslocamentoRepository')} repository
   * @param {import('./SpotfireProvider')}        spotfireProvider
   * @param {string[]}  polos              — lista de polos a sincronizar
   * @param {number}    refreshIntervalMs  — intervalo de refresh (padrão: 30 min)
   */
  constructor(
    repository,
    spotfireProvider,
    polos = ['ATLANTICO', 'DECEN', 'DNORT'],
    refreshIntervalMs = 30 * 60 * 1000,
  ) {
    this._repo = repository;
    this._spotfire = spotfireProvider;
    this._polos = polos;
    this._intervalMs = refreshIntervalMs;
    this._timer = null;
    this._logger = Logger.create('DeslocamentoService');

    // Para ambientes com muitas requisições (dashboard trocando filtro master),
    // evitamos bater no Spotfire repetidamente em janelas curtas.
    // - Coalesce: múltiplas requests idênticas aguardam a mesma Promise.
    // - Cache curto: se o dado foi atualizado há poucos ms, retornamos o cache.
    const envMaxAge = parseInt(process.env.DESLOCAMENTO_ONDEMAND_MAX_AGE_MS || '', 10);
    this._onDemandMaxAgeMs = Number.isFinite(envMaxAge) ? envMaxAge : 20000;
    this._inflight = new Map();

    /** Cache agregado para Base=(All) (TODOS). */
    this._todosCache = { items: [], total: 0, lastUpdated: null };

    // Mutex simples para serializar operações no Spotfire (uma única page compartilhada).
    // Evita concorrência entre scheduler e requests on-demand que causa navegação/reload no meio do evaluate.
    this._spotfireQueue = Promise.resolve();

    /**
     * Cache por polo.
     * @type {Map<string, { items: import('./Deslocamento')[], total: number, lastUpdated: string|null }>}
     */
    this._cache = new Map(
      polos.map((polo) => [polo, { items: [], total: 0, lastUpdated: null }]),
    );
  }

  _isFresh(lastUpdated, maxAgeMs) {
    if (!lastUpdated) return false;
    const t = Date.parse(lastUpdated);
    if (!Number.isFinite(t)) return false;
    return (Date.now() - t) <= maxAgeMs;
  }

  _coalesce(key, fn) {
    const existing = this._inflight.get(key);
    if (existing) return existing;
    const p = Promise.resolve().then(fn);
    this._inflight.set(key, p);
    p.finally(() => this._inflight.delete(key)).catch(() => {});
    return p;
  }

  async _withSpotfireLock(label, fn) {
    const run = async () => {
      this._logger.info(`Lock Spotfire: ${label}`);
      return fn();
    };

    const p = this._spotfireQueue.then(run, run);
    // Mantém a fila viva mesmo se der erro
    this._spotfireQueue = p.catch(() => {});
    return p;
  }

  // ── Scheduler ────────────────────────────────────────────────────

  /**
   * Inicializa o SpotfireProvider: faz login e navega até o relatório.
   * Não extrai dados — a extração ocorre apenas sob demanda (request da API).
   */
  async initialize() {
    this._logger.info('Inicializando Spotfire (login + navegação ao relatório)...');
    await this._spotfire.initialize();
    this._logger.info('Spotfire pronto. Aguardando requisições do dashboard.');
  }

  /**
   * Inicializa o SpotfireProvider, executa a primeira carga de todos os
   * polos e agenda o refresh periódico.
   * @deprecated Use initialize() para inicialização sem extração automática.
   */
  async startScheduler() {
    this._logger.info(`Iniciando scheduler — ${this._polos.join(', ')} | refresh ${this._intervalMs / 60000} min`);
    await this._spotfire.initialize();
    await this._tick();
    this._timer = setInterval(() => this._tick(), this._intervalMs);
  }

  /** Para o scheduler sem encerrar o browser. */
  stopScheduler() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._logger.info('Scheduler parado');
  }

  /** Para o scheduler e encerra o browser do Spotfire. */
  async shutdown() {
    this.stopScheduler();
    await this._spotfire.shutdown();
  }

  // ── Acesso aos dados ─────────────────────────────────────────────

  /**
   * Retorna os dados de um polo específico do cache.
   * @param {string} polo
   */
  getDataByPolo(polo) {
    if (!this._cache.has(polo)) {
      throw new Error(`Polo desconhecido: "${polo}". Disponíveis: ${this._polos.join(', ')}`);
    }
    return { ...this._cache.get(polo) };
  }

  /**
   * Retorna os dados de todos os polos do cache em um único objeto.
   * @returns {{ polos: Object, lastUpdated: string|null }}
   */
  getAllData() {
    const polos = {};
    for (const [polo, data] of this._cache) {
      polos[polo] = data;
    }
    const timestamps = [...this._cache.values()]
      .map((d) => d.lastUpdated)
      .filter(Boolean);

    return {
      polos,
      lastUpdated: timestamps.length ? timestamps.sort().at(-1) : null,
    };
  }

  /**
   * Lista os polos configurados.
   * @returns {string[]}
   */
  getPolos() {
    return [...this._polos];
  }

  // ── Busca avulsa (on-demand) ──────────────────────────────────────

  /**
   * Força uma busca imediata para um polo, atualiza o cache e retorna.
   * Útil para refresh manual via API.
   * @param {string} polo
   */
  async fetchPolo(polo) {
    this._logger.info(`Fetch manual — polo: ${polo}`);

    return this._coalesce(`fetchPolo:${polo}`, async () => {
      const cached = this._cache.get(polo);
      if (cached && this._isFresh(cached.lastUpdated, this._onDemandMaxAgeMs)) {
        this._logger.info(`[${polo}] cache hit (<=${this._onDemandMaxAgeMs}ms)`);
        return this.getDataByPolo(polo);
      }

      return this._withSpotfireLock(`fetchPolo(${polo})`, async () => {
        // Garantia: o endpoint on-demand pode ser chamado mesmo quando o scheduler
        // de Spotfire falhou na inicialização. initialize() é idempotente.
        await this._spotfire.initialize();
        await this._refreshPoloUnsafe(polo, { throwOnError: true });
        return this.getDataByPolo(polo);
      });
    });
  }

  /**
   * Força uma busca imediata com Base=(All) no Spotfire (uso: master=TODOS).
   * Não atualiza o cache por polo; retorna o agregado direto.
   */
  async fetchTodos() {
    this._logger.info('Fetch manual — polo: TODOS');

    return this._coalesce('fetchTodos', async () => {
      if (this._isFresh(this._todosCache.lastUpdated, this._onDemandMaxAgeMs)) {
        this._logger.info(`[TODOS] cache hit (<=${this._onDemandMaxAgeMs}ms)`);
        return { ...this._todosCache };
      }

      return this._withSpotfireLock('fetchTodos', async () => {
        // Garantia: o endpoint on-demand pode ser chamado mesmo quando o scheduler
        // de Spotfire falhou na inicialização. initialize() é idempotente.
        await this._spotfire.initialize();
        const result = await this._runWithSpotfireRecovery('fetchTodos', () => this._repo.findAll());
        this._todosCache = {
          items: result.items,
          total: result.total,
          lastUpdated: new Date().toISOString(),
        };
        return { ...this._todosCache };
      });
    });
  }

  // ── Privado ───────────────────────────────────────────────────────

  /** Ciclo de refresh: itera sobre todos os polos e atualiza o cache. */
  async _tick() {
    const now = new Date().toLocaleTimeString();
    this._logger.info(`Atualizando todos os polos... (${now})`);

    for (const polo of this._polos) {
      await this._refreshPolo(polo);
    }

    this._logger.info('Cache atualizado para todos os polos');
  }

  /** Atualiza o cache de um polo específico. */
  async _refreshPolo(polo, { throwOnError = false } = {}) {
    return this._withSpotfireLock(`refreshPolo(${polo})`, async () => {
      await this._spotfire.initialize();
      return this._refreshPoloUnsafe(polo, { throwOnError });
    });
  }

  async _refreshPoloUnsafe(polo, { throwOnError = false } = {}) {
    try {
      const result = await this._runWithSpotfireRecovery(`refreshPolo(${polo})`, () => this._repo.findByPolo(polo));
      this._cache.set(polo, {
        items: result.items,
        total: result.total,
        lastUpdated: new Date().toISOString(),
      });
      this._logger.info(`[${polo}] cache: ${result.total} registros`);
      return result;
    } catch (error) {
      this._logger.error(`[${polo}] Erro ao atualizar: ${error.message}`);
      if (process.env.NODE_ENV !== 'production' && error?.stack) {
        this._logger.error(error.stack);
      }
      if (throwOnError) throw error;
      return null;
    }
  }

  async _runWithSpotfireRecovery(label, operation) {
    try {
      return await operation();
    } catch (error) {
      if (!this._isRecoverableSpotfireError(error) || typeof this._spotfire?.resetSession !== 'function') {
        throw error;
      }

      this._logger.warn(`[${label}] Falha recuperável do Spotfire: ${error.message}. Resetando sessão e tentando novamente...`);
      await this._spotfire.resetSession();
      return operation();
    }
  }

  _isRecoverableSpotfireError(error) {
    const message = String(error?.message || '');
    return [
      'Protocol error',
      'Connection closed',
      'Target closed',
      'Session closed',
      'detached Frame',
      'Execution context was destroyed',
    ].some((fragment) => message.includes(fragment));
  }
}

module.exports = DeslocamentoService;
