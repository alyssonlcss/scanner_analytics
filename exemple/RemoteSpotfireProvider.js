class RemoteSpotfireProvider {
  constructor(client) {
    this._client = client;
    this._isInitialized = false;
  }

  async initialize() {
    await this._client.request('spotfire.initialize');
    this._isInitialized = true;
  }

  async shutdown() {
    await this._client.request('spotfire.shutdown');
    this._isInitialized = false;
  }

  async resetSession() {
    await this._client.request('spotfire.resetSession');
    this._isInitialized = true;
    return true;
  }

  isInitialized() {
    return this._isInitialized;
  }
}

module.exports = RemoteSpotfireProvider;