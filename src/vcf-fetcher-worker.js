import { text } from 'd3-request';
import { bisector } from 'd3-array';
import { tsvParseRows } from 'd3-dsv';
import { scaleLinear, scaleLog } from 'd3-scale';
import { expose, Transfer } from 'threads/worker';
import { TabixIndexedFile } from '@gmod/tabix';
import VCF from '@gmod/vcf';
import { RemoteFile } from 'generic-filehandle';
import LRU from 'lru-cache';
import slugid from 'slugid';
import { PILEUP_COLOR_IXS } from './vcf-utils';

function currTime() {
  const d = new Date();
  return d.getTime();
}
/////////////////////////////////////////////////
/// ChromInfo
/////////////////////////////////////////////////

const chromInfoBisector = bisector((d) => d.pos).left;

const chrToAbs = (chrom, chromPos, chromInfo) =>
  chromInfo.chrPositions[chrom].pos + chromPos;

const absToChr = (absPosition, chromInfo) => {
  if (!chromInfo || !chromInfo.cumPositions || !chromInfo.cumPositions.length) {
    return null;
  }

  let insertPoint = chromInfoBisector(chromInfo.cumPositions, absPosition);
  const lastChr = chromInfo.cumPositions[chromInfo.cumPositions.length - 1].chr;
  const lastLength = chromInfo.chromLengths[lastChr];

  insertPoint -= insertPoint > 0 && 1;

  let chrPosition = Math.floor(
    absPosition - chromInfo.cumPositions[insertPoint].pos,
  );
  let offset = 0;

  if (chrPosition < 0) {
    // before the start of the genome
    offset = chrPosition - 1;
    chrPosition = 1;
  }

  if (
    insertPoint === chromInfo.cumPositions.length - 1 &&
    chrPosition > lastLength
  ) {
    // beyond the last chromosome
    offset = chrPosition - lastLength;
    chrPosition = lastLength;
  }

  return [
    chromInfo.cumPositions[insertPoint].chr,
    chrPosition,
    offset,
    insertPoint,
  ];
};

function parseChromsizesRows(data) {
  const cumValues = [];
  const chromLengths = {};
  const chrPositions = {};

  let totalLength = 0;

  for (let i = 0; i < data.length; i++) {
    const length = Number(data[i][1]);
    totalLength += length;

    const newValue = {
      id: i,
      chr: data[i][0],
      pos: totalLength - length,
    };

    cumValues.push(newValue);
    chrPositions[newValue.chr] = newValue;
    chromLengths[data[i][0]] = length;
  }

  return {
    cumPositions: cumValues,
    chrPositions,
    totalLength,
    chromLengths,
  };
}

function ChromosomeInfo(filepath, success) {
  const ret = {};

  ret.absToChr = (absPos) => (ret.chrPositions ? absToChr(absPos, ret) : null);

  ret.chrToAbs = ([chrName, chrPos] = []) =>
    ret.chrPositions ? chrToAbs(chrName, chrPos, ret) : null;

  return text(filepath, (error, chrInfoText) => {
    if (error) {
      // console.warn('Chromosome info not found at:', filepath);
      if (success) success(null);
    } else {
      const data = tsvParseRows(chrInfoText);
      const chromInfo = parseChromsizesRows(data);

      Object.keys(chromInfo).forEach((key) => {
        ret[key] = chromInfo[key];
      });
      if (success) success(ret);
    }
  });
}

/////////////////////////////////////////////////////
/// End Chrominfo
/////////////////////////////////////////////////////

const vcfRecordToJson = (vcfRecord, chrName, chrOffset) => {
  const segments = [];
  const info = vcfRecord['INFO'];

  // VCF records can have multiple ALT. We create a segment for each of them
  vcfRecord['ALT'].forEach((alt, index) => {
    const segment = {
      id: slugid.nice(),
      alt: alt,
      ref: vcfRecord.REF,
      from: vcfRecord.POS + chrOffset,
      to: vcfRecord.POS + chrOffset + vcfRecord.REF.length,
      chrName,
      chrOffset,
      alleleCount: info.AC[index],
      alleleFrequency: info.AF[index],
      alleleNumber: info.AN[index],
      row: null,
      type: 'variant',
    };

    if (segment['alt'].length > segment['ref'].length) {
      segment['type'] = 'insertion';
    } else if (segment['alt'].length < segment['ref'].length) {
      segment['type'] = 'deletion';
    }

    segments.push(segment);
  });

  return segments;
};

// promises indexed by urls
const vcfFiles = {};
const vcfHeaders = {};
const tbiVCFParsers = {};

const MAX_TILES = 20;

// promises indexed by url
const chromSizes = {};
const chromInfos = {};
const tileValues = new LRU({ max: MAX_TILES });
const tilesetInfos = {};

// indexed by uuid
const dataConfs = {};

const init = (uid, vcfUrl, tbiUrl, chromSizesUrl) => {
  if (!vcfFiles[vcfUrl]) {
    vcfFiles[vcfUrl] = new TabixIndexedFile({
      filehandle: new RemoteFile(vcfUrl),
      tbiFilehandle: new RemoteFile(tbiUrl),
    });

    vcfHeaders[vcfUrl] = vcfFiles[vcfUrl].getHeader();
    // vcfFiles[vcfUrl].getHeader().then(headerText => {
    //   vcfHeaders[vcfUrl] = headerText;
    //   tbiVCFParsers[vcfUrl] = new VCF({ header: headerText });

    // });
  }

  if (chromSizesUrl) {
    chromSizes[chromSizesUrl] =
      chromSizes[chromSizesUrl] ||
      new Promise((resolve) => {
        ChromosomeInfo(chromSizesUrl, resolve);
      });
  }

  dataConfs[uid] = {
    vcfUrl,
    chromSizesUrl,
  };
};

const tilesetInfo = (uid) => {
  const { chromSizesUrl, vcfUrl } = dataConfs[uid];
  const promises = [vcfHeaders[vcfUrl], chromSizes[chromSizesUrl]];

  return Promise.all(promises).then((values) => {
    if (!tbiVCFParsers[vcfUrl]) {
      tbiVCFParsers[vcfUrl] = new VCF({ header: values[0] });
    }

    const TILE_SIZE = 1024;
    const chromInfo = values[1];
    chromInfos[chromSizesUrl] = chromInfo;

    const retVal = {
      tile_size: TILE_SIZE,
      bins_per_dimension: TILE_SIZE,
      max_zoom: Math.ceil(
        Math.log(chromInfo.totalLength / TILE_SIZE) / Math.log(2),
      ),
      max_width: chromInfo.totalLength,
      min_pos: [0],
      max_pos: [chromInfo.totalLength],
    };

    tilesetInfos[uid] = retVal;
    return retVal;
  });
};

const tile = async (uid, z, x) => {
  const MAX_TILE_WIDTH = 200000;
  const { vcfUrl, chromSizesUrl } = dataConfs[uid];
  const vcfFile = vcfFiles[vcfUrl];

  return tilesetInfo(uid).then((tsInfo) => {
    const tileWidth = +tsInfo.max_width / 2 ** +z;
    const recordPromises = [];

    if (tileWidth > MAX_TILE_WIDTH) {
      // this.errorTextText('Zoomed out too far for this track. Zoomin further to see reads');
      return new Promise((resolve) => resolve([]));
    }

    // get the bounds of the tile
    let minX = tsInfo.min_pos[0] + x * tileWidth;
    const maxX = tsInfo.min_pos[0] + (x + 1) * tileWidth;

    const chromInfo = chromInfos[chromSizesUrl];

    const { chromLengths, cumPositions } = chromInfo;

    const variants = [];

    for (let i = 0; i < cumPositions.length; i++) {
      const chromName = cumPositions[i].chr;
      const chromStart = cumPositions[i].pos;

      const chromEnd = cumPositions[i].pos + chromLengths[chromName];
      tileValues.set(`${uid}.${z}.${x}`, []);

      if (chromStart <= minX && minX < chromEnd) {
        // start of the visible region is within this chromosome

        if (maxX > chromEnd) {
          // the visible region extends beyond the end of this chromosome
          // fetch from the start until the end of the chromosome
          const startPos = minX - chromStart;
          const endPos = chromEnd - chromStart;

          recordPromises.push(
            vcfFile.getLines(chromName, startPos, endPos, (line) => {
              const vcfRecord = tbiVCFParsers[vcfUrl].parseLine(line);
              const vcfJson = vcfRecordToJson(
                vcfRecord,
                chromName,
                cumPositions[i].pos,
              );
              vcfJson.forEach((variant) => variants.push(variant));
            }),
          );
          minX = chromEnd;
        } else {
          const endPos = Math.ceil(maxX - chromStart);
          const startPos = Math.floor(minX - chromStart);

          recordPromises.push(
            vcfFile.getLines(chromName, startPos, endPos, (line) => {
              const vcfRecord = tbiVCFParsers[vcfUrl].parseLine(line);
              const vcfJson = vcfRecordToJson(
                vcfRecord,
                chromName,
                cumPositions[i].pos,
              );
              vcfJson.forEach((variant) => variants.push(variant));
            }),
          );

          // end the loop because we've retrieved the last chromosome
          break;
        }
      }
    }

    // flatten the array of promises so that it looks like we're
    // getting one long list of value
    return Promise.all(recordPromises).then(() => {
      //console.log(variants);
      tileValues.set(`${uid}.${z}.${x}`, variants);
      return variants;
    });
  });
};

const fetchTilesDebounced = async (uid, tileIds) => {
  const tiles = {};

  const validTileIds = [];
  const tilePromises = [];

  for (const tileId of tileIds) {
    const parts = tileId.split('.');
    const z = parseInt(parts[0], 10);
    const x = parseInt(parts[1], 10);

    if (Number.isNaN(x) || Number.isNaN(z)) {
      console.warn('Invalid tile zoom or position:', z, x);
      continue;
    }

    validTileIds.push(tileId);
    tilePromises.push(tile(uid, z, x));
  }

  return Promise.all(tilePromises).then((values) => {
    for (let i = 0; i < values.length; i++) {
      const validTileId = validTileIds[i];
      tiles[validTileId] = values[i];
      tiles[validTileId].tilePositionId = validTileId;
    }

    return tiles;
  });
};

///////////////////////////////////////////////////
/// Render Functions
///////////////////////////////////////////////////

const STARTING_POSITIONS_ARRAY_LENGTH = 2 ** 20;
const STARTING_COLORS_ARRAY_LENGTH = 2 ** 21;
const STARTING_INDEXES_LENGTH = 2 ** 21;

let allPositionsLength = STARTING_POSITIONS_ARRAY_LENGTH;
let allColorsLength = STARTING_COLORS_ARRAY_LENGTH;
let allIndexesLength = STARTING_INDEXES_LENGTH;

let allPositions = new Float32Array(allPositionsLength);
let allColors = new Float32Array(allColorsLength);
let allIndexes = new Int32Array(allIndexesLength);

const renderSegments = (
  uid,
  tileIds,
  domain,
  scaleRange,
  trackOptions,
  labelPositions,
) => {
  //const t1 = currTime();
  const allSegments = {};

  for (const tileId of tileIds) {
    const tileValue = tileValues.get(`${uid}.${tileId}`);

    if (tileValue.error) {
      throw new Error(tileValue.error);
    }

    for (const segment of tileValue) {
      allSegments[segment.id] = segment;
    }
  }

  const segmentList = Object.values(allSegments);

  let [minPos, maxPos] = [Number.MAX_VALUE, -Number.MAX_VALUE];

  for (let i = 0; i < segmentList.length; i++) {
    if (segmentList[i].from < minPos) {
      minPos = segmentList[i].from;
    }

    if (segmentList[i].to > maxPos) {
      maxPos = segmentList[i].to;
    }
  }

  let currPosition = 0;
  let currColor = 0;
  let currIdx = 0;

  const addPosition = (x1, y1) => {
    if (currPosition > allPositionsLength - 2) {
      allPositionsLength *= 2;
      const prevAllPositions = allPositions;

      allPositions = new Float32Array(allPositionsLength);
      allPositions.set(prevAllPositions);
    }
    allPositions[currPosition++] = x1;
    allPositions[currPosition++] = y1;

    return currPosition / 2 - 1;
  };

  const addColor = (colorIdx, n) => {
    if (currColor >= allColorsLength - n) {
      allColorsLength *= 2;
      const prevAllColors = allColors;

      allColors = new Float32Array(allColorsLength);
      allColors.set(prevAllColors);
    }

    for (let k = 0; k < n; k++) {
      allColors[currColor++] = colorIdx;
    }
  };

  const addTriangleIxs = (ix1, ix2, ix3) => {
    if (currIdx >= allIndexesLength - 3) {
      allIndexesLength *= 2;
      const prevAllIndexes = allIndexes;

      allIndexes = new Int32Array(allIndexesLength);
      allIndexes.set(prevAllIndexes);
    }

    allIndexes[currIdx++] = ix1;
    allIndexes[currIdx++] = ix2;
    allIndexes[currIdx++] = ix3;
  };

  const addRect = (x, y, width, height, colorIdx) => {
    const xLeft = x;
    const xRight = xLeft + width;
    const yTop = y;
    const yBottom = y + height;

    const ulIx = addPosition(xLeft, yTop);
    const urIx = addPosition(xRight, yTop);
    const llIx = addPosition(xLeft, yBottom);
    const lrIx = addPosition(xRight, yBottom);
    addColor(colorIdx, 4);

    addTriangleIxs(ulIx, urIx, llIx);
    addTriangleIxs(llIx, lrIx, urIx);
  };

  const xScale = scaleLinear().domain(domain).range(scaleRange);

  const pos0 = labelPositions[0];
  const pos10m5 = labelPositions[1];
  const pos10m0 = labelPositions[labelPositions.length - 1];

  const logYScale10m5 = scaleLog().domain([1e-5, 1]).range([pos10m5, pos10m0]);
  const logYScale10m9 = scaleLog().domain([1e-8, 1e-5]).range([pos0, pos10m5]);

  let xLeft;
  let xRight;
  let yTop;

  // Needed to check for duplicates
  segmentList.sort((a, b) => a.from - b.from);
  let lastSegment = null;

  segmentList.forEach((segment, j) => {
    // Ignore duplicates - can happen when variants span more than one tile
    if (
      lastSegment &&
      segment.from === lastSegment.from &&
      segment.ref === lastSegment.ref &&
      segment.alt === lastSegment.alt
    ) {
      return;
    }
    lastSegment = segment;

    const from = xScale(segment.from);
    const to = xScale(segment.to);

    if (segment.alleleFrequency >= 1e-5) {
      yTop =
        logYScale10m5(segment.alleleFrequency) - trackOptions.variantHeight / 2;
    } else if (segment.alleleFrequency >= 1e-8) {
      yTop =
        logYScale10m9(segment.alleleFrequency) - trackOptions.variantHeight / 2;
    } else {
      yTop = 0;
    }
    // Shift everything by one, since the graphics starts at 1
    yTop += 1;

    const width = to - from;
    // This is needed because a constant padding would be too large, if the
    // initial rendering is happing zoomed out
    const padding = Math.min(0.5, 0.01 * width);

    xLeft = from + padding;
    xRight = to - padding;

    let colorToUse = PILEUP_COLOR_IXS.VARIANT;
    if (segment.type === 'deletion') {
      colorToUse = PILEUP_COLOR_IXS.DELETION;
    } else if (segment.type === 'insertion') {
      colorToUse = PILEUP_COLOR_IXS.INSERTION;
    }
    segment['yTop'] = yTop;
    addRect(
      xLeft,
      yTop,
      xRight - xLeft,
      trackOptions.variantHeight,
      colorToUse,
    );
  });

  const positionsBuffer = allPositions.slice(0, currPosition).buffer;
  const colorsBuffer = allColors.slice(0, currColor).buffer;
  const ixBuffer = allIndexes.slice(0, currIdx).buffer;

  const objData = {
    variants: segmentList,
    positionsBuffer,
    colorsBuffer,
    ixBuffer,
    xScaleDomain: domain,
    xScaleRange: scaleRange,
  };

  //const t2 = currTime();
  //console.log('renderSegments time:', t2 - t1, 'ms');

  return Transfer(objData, [objData.positionsBuffer, colorsBuffer, ixBuffer]);
};

const tileFunctions = {
  init,
  tilesetInfo,
  fetchTilesDebounced,
  tile,
  renderSegments,
};

expose(tileFunctions);
