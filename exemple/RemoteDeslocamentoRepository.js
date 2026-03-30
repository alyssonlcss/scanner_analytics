class RemoteDeslocamentoRepository {
  constructor(client) {
    this._client = client;
  }

  async findByPolo(polo) {
    return this._client.request('deslocamento.findByPolo', { polo });
  }

  async findAll() {
    return this._client.request('deslocamento.findAll');
  }
}

module.exports = RemoteDeslocamentoRepository;