const DEBOUNCE_TIME = 200;

class VCFDataFetcher {
  constructor(dataConfig, worker, HGC) {
    this.dataConfig = dataConfig;
    this.uid = HGC.libraries.slugid.nice();
    this.worker = worker;
    this.prevRequestTime = 0;

    this.toFetch = new Set();
    this.fetchTimeout = null;

    this.tbiIndexed = null;
    this.tbiVCFParser = null;

    this.initPromise = this.worker.then((tileFunctions) => {
      if (!dataConfig.tbiUrl) {
        dataConfig['tbiUrl'] = dataConfig['vcfUrl'] + '.tbi';
      }

      return tileFunctions
        .init(
          this.uid,
          dataConfig.vcfUrl,
          dataConfig.tbiUrl,
          dataConfig.chromSizesUrl,
          dataConfig.maxTileWidth
        )
        .then(() => this.worker);
    });
  }

  tilesetInfo(callback) {
    console.log('tilesetInfo');
    this.worker.then((tileFunctions) => {
      tileFunctions.tilesetInfo(this.uid).then(callback);
    });
  }

  fetchTilesDebounced(receivedTiles, tileIds) {
    const { toFetch } = this;

    const thisZoomLevel = tileIds[0].split('.')[0];
    const toFetchZoomLevel = toFetch.size
      ? [...toFetch][0].split('.')[0]
      : null;

    if (thisZoomLevel !== toFetchZoomLevel) {
      for (const tileId of this.toFetch) {
        this.track.fetching.delete(tileId);
      }
      this.toFetch.clear();
    }

    tileIds.forEach((x) => this.toFetch.add(x));

    if (this.fetchTimeout) {
      clearTimeout(this.fetchTimeout);
    }

    this.fetchTimeout = setTimeout(() => {
      this.sendFetch(receivedTiles, [...this.toFetch]);
      this.toFetch.clear();
    }, DEBOUNCE_TIME);
  }

  sendFetch(receivedTiles, tileIds) {
    this.track.updateLoadingText();

    this.worker.then((tileFunctions) => {
      tileFunctions.fetchTilesDebounced(this.uid, tileIds).then(receivedTiles);
    });
  }
}

export default VCFDataFetcher;
