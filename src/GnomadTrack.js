import VCFDataFetcher from './vcf-fetcher';
import MyWorkerWeb from 'raw-loader!../dist/worker.js';
import { spawn, BlobWorker } from 'threads';
import { PILEUP_COLORS } from './vcf-utils';
import sanitizeHtml from 'sanitize-html';

const createColorTexture = (PIXI, colors) => {
  const colorTexRes = Math.max(2, Math.ceil(Math.sqrt(colors.length)));
  const rgba = new Float32Array(colorTexRes ** 2 * 4);
  colors.forEach((color, i) => {
    // eslint-disable-next-line prefer-destructuring
    rgba[i * 4] = color[0]; // r
    // eslint-disable-next-line prefer-destructuring
    rgba[i * 4 + 1] = color[1]; // g
    // eslint-disable-next-line prefer-destructuring
    rgba[i * 4 + 2] = color[2]; // b
    // eslint-disable-next-line prefer-destructuring
    rgba[i * 4 + 3] = color[3]; // a
  });

  return [PIXI.Texture.fromBuffer(rgba, colorTexRes, colorTexRes), colorTexRes];
};

function invY(p, t) {
  return (p - t.y) / t.k;
}

const scaleScalableGraphics = (graphics, xScale, drawnAtScale) => {
  const tileK =
    (drawnAtScale.domain()[1] - drawnAtScale.domain()[0]) /
    (xScale.domain()[1] - xScale.domain()[0]);
  const newRange = xScale.domain().map(drawnAtScale);

  const posOffset = newRange[0];
  graphics.scale.x = tileK;
  graphics.position.x = -posOffset * tileK;
};

const getTilePosAndDimensions = (
  zoomLevel,
  tilePos,
  binsPerTileIn,
  tilesetInfo,
) => {
  /**
   * Get the tile's position in its coordinate system.
   *
   * TODO: Replace this function with one imported from
   * HGC.utils.trackUtils
   */
  const xTilePos = tilePos[0];
  const yTilePos = tilePos[1];

  if (tilesetInfo.resolutions) {
    // the default bins per tile which should
    // not be used because the right value should be in the tileset info

    const binsPerTile = binsPerTileIn;

    const sortedResolutions = tilesetInfo.resolutions
      .map((x) => +x)
      .sort((a, b) => b - a);

    const chosenResolution = sortedResolutions[zoomLevel];

    const tileWidth = chosenResolution * binsPerTile;
    const tileHeight = tileWidth;

    const tileX = chosenResolution * binsPerTile * tilePos[0];
    const tileY = chosenResolution * binsPerTile * tilePos[1];

    return {
      tileX,
      tileY,
      tileWidth,
      tileHeight,
    };
  }

  // max_width should be substitutable with 2 ** tilesetInfo.max_zoom
  const totalWidth = tilesetInfo.max_width;
  const totalHeight = tilesetInfo.max_width;

  const minX = tilesetInfo.min_pos[0];
  const minY = tilesetInfo.min_pos[1];

  const tileWidth = totalWidth / 2 ** zoomLevel;
  const tileHeight = totalHeight / 2 ** zoomLevel;

  const tileX = minX + xTilePos * tileWidth;
  const tileY = minY + yTilePos * tileHeight;

  return {
    tileX,
    tileY,
    tileWidth,
    tileHeight,
  };
};

function eqSet(as, bs) {
  return as.size === bs.size && all(isIn(bs), as);
}

function all(pred, as) {
  for (var a of as) if (!pred(a)) return false;
  return true;
}

function isIn(as) {
  return function (a) {
    return as.has(a);
  };
}

const GnomadTrack = (HGC, ...args) => {
  if (!new.target) {
    throw new Error(
      'Uncaught TypeError: Class constructor cannot be invoked without "new"',
    );
  }

  class GnomadTrackClass extends HGC.tracks.Tiled1DPixiTrack {
    constructor(context, options) {
      const worker = spawn(BlobWorker.fromText(MyWorkerWeb));
      // this is where the threaded tile fetcher is called
      context.dataConfig['maxTileWidth'] = options.maxTileWidth;
      context.dataFetcher = new VCFDataFetcher(context.dataConfig, worker, HGC);
      super(context, options);
      context.dataFetcher.track = this;

      this.worker = worker;
      this.valueScaleTransform = HGC.libraries.d3Zoom.zoomIdentity;

      this.trackId = this.id;
      this.viewId = context.viewUid;

      // we scale the entire view up until a certain point
      // at which point we redraw everything to get rid of
      // artifacts
      // this.drawnAtScale keeps track of the scale at which
      // we last rendered everything
      this.drawnAtScale = HGC.libraries.d3Scale.scaleLinear();
      this.variantList = [];

      // graphics for highliting reads under the cursor
      this.mouseOverGraphics = new HGC.libraries.PIXI.Graphics();
      this.loadingText = new HGC.libraries.PIXI.Text('Loading', {
        fontSize: '12px',
        fontFamily: 'Arial',
        fill: 'grey',
      });

      this.loadingText.x = 40;
      this.loadingText.y = 110;

      this.loadingText.anchor.x = 0;
      this.loadingText.anchor.y = 0;

      this.fetching = new Set();
      this.rendering = new Set();

      this.isShowGlobalMousePosition = context.isShowGlobalMousePosition;

      if (this.options.showMousePosition && !this.hideMousePosition) {
        this.hideMousePosition = HGC.utils.showMousePosition(
          this,
          this.is2d,
          this.isShowGlobalMousePosition(),
        );
      }

      this.pLabel.addChild(this.loadingText);
      this.setUpShaderAndTextures();

      // Used for axis labels and horizontal lines
      this.legendGraphics = new HGC.libraries.PIXI.Graphics();
      this.pForeground.addChild(this.legendGraphics);

      // Create the legend text here once
      this.legendTextsBase = [];
      this.legendTextsExponent = [];

      const pixiTextOptions = {
        fontSize: '12px',
        fontFamily: 'Arial',
        fill: '#333333',
      };

      const pixiTextSmOptions = {
        fontSize: '8px',
        fontFamily: 'Arial',
        fill: '#333333',
      };

      this.legendTextsBase.push(
        new HGC.libraries.PIXI.Text('0', pixiTextOptions),
      );
      for (let i = 5; i > 0; i--) {
        const base = new HGC.libraries.PIXI.Text('10', pixiTextOptions);
        this.legendTextsBase.push(base);

        const exp = new HGC.libraries.PIXI.Text('-' + i, pixiTextSmOptions);
        this.legendTextsExponent.push(exp);
      }
      this.legendTextsBase.push(
        new HGC.libraries.PIXI.Text('1', pixiTextOptions),
      );
    }

    initTile(tile) {
      tile.bgGraphics = new HGC.libraries.PIXI.Graphics();
      tile.graphics.addChild(tile.bgGraphics);
    }

    getLabelPositions() {
      const trackHeight = this.dimensions[1];
      const numLabels = this.legendTextsBase.length;
      const dist = trackHeight / numLabels;
      const labelPositions = [];

      for (let k = 0; k < numLabels; k++) {
        labelPositions.push(dist * k + this.options.variantHeight / 2);
      }
      return labelPositions;
    }

    getBoundsOfTile(tile) {
      // get the bounds of the tile
      const tileId = +tile.tileId.split('.')[1];
      const zoomLevel = +tile.tileId.split('.')[0]; //track.zoomLevel does not always seem to be up to date
      const tileWidth = +this.tilesetInfo.max_width / 2 ** zoomLevel;
      const tileMinX = this.tilesetInfo.min_pos[0] + tileId * tileWidth; // abs coordinates
      const tileMaxX = this.tilesetInfo.min_pos[0] + (tileId + 1) * tileWidth;

      return [tileMinX, tileMaxX];
    }

    setUpShaderAndTextures() {
      const colorDict = PILEUP_COLORS;

      if (this.options && this.options.colorScale) {
        [
          colorDict.VARIANT,
          colorDict.INSERTION,
          colorDict.DELETION,
          colorDict.INVERSION,
          colorDict.DUPLICATION
        ] = this.options.colorScale.map((x) => x);
      }

      const colors = Object.values(colorDict);

      const [colorMapTex, colorMapTexRes] = createColorTexture(
        HGC.libraries.PIXI,
        colors,
      );
      const uniforms = new HGC.libraries.PIXI.UniformGroup({
        uColorMapTex: colorMapTex,
        uColorMapTexRes: colorMapTexRes,
      });
      this.shader = HGC.libraries.PIXI.Shader.from(
        `
    attribute vec2 position;
    attribute float aColorIdx;

    uniform mat3 projectionMatrix;
    uniform mat3 translationMatrix;

    uniform sampler2D uColorMapTex;
    uniform float uColorMapTexRes;

    varying vec4 vColor;

    void main(void)
    {
        // Half a texel (i.e., pixel in texture coordinates)
        float eps = 0.5 / uColorMapTexRes;
        float colorRowIndex = floor((aColorIdx + eps) / uColorMapTexRes);
        vec2 colorTexIndex = vec2(
          (aColorIdx / uColorMapTexRes) - colorRowIndex + eps,
          (colorRowIndex / uColorMapTexRes) + eps
        );
        vColor = texture2D(uColorMapTex, colorTexIndex);

        gl_Position = vec4((projectionMatrix * translationMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
    }

`,
        `
varying vec4 vColor;

    void main(void) {
        gl_FragColor = vColor;
    }
`,
        uniforms,
      );
    }

    rerender(options) {
      super.rerender(options);

      this.options = options;

      if (this.options.showMousePosition && !this.hideMousePosition) {
        this.hideMousePosition = HGC.utils.showMousePosition(
          this,
          this.is2d,
          this.isShowGlobalMousePosition(),
        );
      }

      if (!this.options.showMousePosition && this.hideMousePosition) {
        this.hideMousePosition();
        this.hideMousePosition = undefined;
      }

      this.setUpShaderAndTextures();
      this.updateExistingGraphics();
    }

    createLegendGraphics() {
      this.legendGraphics.clear();

      const trackHeight = this.dimensions[1];
      const numLabels = this.legendTextsBase.length;
      const dist = trackHeight / numLabels;

      this.legendGraphics.beginFill(HGC.utils.colorToHex('#ffffff'));
      this.legendGraphics.drawRect(0, 0, 30, trackHeight);

      this.legendTextsBase.forEach((pixiText, k) => {
        pixiText.x = 2;
        pixiText.y = dist * k + this.options.variantHeight / 2;
        pixiText.anchor.x = 0;
        pixiText.anchor.y = 0.5;
        this.legendGraphics.addChild(pixiText);
      });

      this.legendTextsExponent.forEach((pixiText, k) => {
        pixiText.x = 17;
        pixiText.y = dist * (k + 1);
        pixiText.anchor.x = 0;
        pixiText.anchor.y = 0;
        this.legendGraphics.addChild(pixiText);
      });
    }

    renderTileBackground(tile) {
      if (!tile) {
        return;
      }
      tile.bgGraphics.removeChildren();
      tile.bgGraphics.clear();

      const bounds = this.getBoundsOfTile(tile);
      tile.tileMinX = bounds[0];
      tile.tileMaxX = bounds[1];
      const minX = this._xScale(tile.tileMinX);
      const maxX = this._xScale(tile.tileMaxX);

      tile.bgGraphics.beginFill(HGC.utils.colorToHex('#ebebeb'));

      const labelPositions = this.getLabelPositions();

      labelPositions.forEach((posY) => {
        tile.bgGraphics.drawRect(minX, posY, maxX - minX, 1);
      });
    }

    updateExistingGraphics() {
      this.loadingText.text = 'Rendering...';

      this.createLegendGraphics();
      this.visibleTileIds.forEach((tileId) => {
        this.renderTileBackground(this.fetchedTiles[tileId]);
      });

      if (
        !eqSet(this.visibleTileIds, new Set(Object.keys(this.fetchedTiles)))
      ) {
        this.updateLoadingText();
        return;
      }

      const fetchedTileKeys = Object.keys(this.fetchedTiles);
      fetchedTileKeys.forEach((x) => {
        this.fetching.delete(x);
        this.rendering.add(x);
      });
      this.updateLoadingText();

      this.worker.then((tileFunctions) => {
        tileFunctions
          .renderSegments(
            this.dataFetcher.uid,
            Object.values(this.fetchedTiles).map((x) => x.remoteId),
            this._xScale.domain(),
            this._xScale.range(),
            this.options,
            this.getLabelPositions(),
          )
          .then((toRender) => {
            this.loadingText.visible = false;
            fetchedTileKeys.forEach((x) => {
              this.rendering.delete(x);
            });
            this.updateLoadingText();

            this.errorTextText = null;
            this.pBorder.clear();
            this.drawError();
            this.animate();

            this.positions = new Float32Array(toRender.positionsBuffer);
            this.colors = new Float32Array(toRender.colorsBuffer);
            this.ixs = new Int32Array(toRender.ixBuffer);

            const newGraphics = new HGC.libraries.PIXI.Graphics();

            this.variantList = toRender.variants;

            const geometry = new HGC.libraries.PIXI.Geometry().addAttribute(
              'position',
              this.positions,
              2,
            ); // x,y
            geometry.addAttribute('aColorIdx', this.colors, 1);
            geometry.addIndex(this.ixs);

            if (this.positions.length) {
              const state = new HGC.libraries.PIXI.State();
              const mesh = new HGC.libraries.PIXI.Mesh(
                geometry,
                this.shader,
                state,
              );

              newGraphics.addChild(mesh);
            }

            this.pMain.x = this.position[0];

            if (this.segmentGraphics) {
              this.pMain.removeChild(this.segmentGraphics);
            }

            this.pMain.addChild(newGraphics);
            this.segmentGraphics = newGraphics;

            // remove and add again to place on top
            this.pMain.removeChild(this.mouseOverGraphics);
            this.pMain.addChild(this.mouseOverGraphics);

            this.drawnAtScale = HGC.libraries.d3Scale
              .scaleLinear()
              .domain(toRender.xScaleDomain)
              .range(toRender.xScaleRange);

            scaleScalableGraphics(
              this.segmentGraphics,
              this._xScale,
              this.drawnAtScale,
            );

            // if somebody zoomed vertically, we want to readjust so that
            // they're still zoomed in vertically
            this.segmentGraphics.scale.y = this.valueScaleTransform.k;
            this.segmentGraphics.position.y = this.valueScaleTransform.y;

            this.draw();
            this.animate();
          });
      });
    }

    updateLoadingText() {
      this.loadingText.visible = true;
      this.loadingText.text = '';

      if (!this.tilesetInfo) {
        this.loadingText.text = 'Fetching tileset info...';
        return;
      }

      if (this.fetching.size) {
        this.loadingText.text = `Fetching... ${[...this.fetching]
          .map((x) => x.split('|')[0])
          .join(' ')}`;
      }

      if (this.rendering.size) {
        this.loadingText.text = `Rendering... ${[...this.rendering].join(' ')}`;
      }

      if (!this.fetching.size && !this.rendering.size) {
        this.loadingText.visible = false;
      }
    }

    draw() {
      this.trackNotFoundText.text = 'Track not found.';
      this.trackNotFoundText.visible = true;
    }

    getMouseOverHtml(trackX, trackYIn) {

      // const trackY = this.valueScaleTransform.invert(track)
      this.mouseOverGraphics.clear();
      // Prevents 'stuck' read outlines when hovering quickly
      requestAnimationFrame(this.animate);
      const trackY = invY(trackYIn, this.valueScaleTransform);
      const vHeight = this.options.variantHeight * this.valueScaleTransform.k;

      const filteredList = this.variantList.filter(
        (variant) =>
          this._xScale(variant.from) <= trackX &&
          trackX <= this._xScale(variant.to) &&
          trackY >= variant.yTop + 1 &&
          trackY <= variant.yTop + vHeight + 1,
      );

      let variantHtml = ``;
      let typeHtml = ``;
      let positionHtml = ``;
      let alleleCountHtml = ``;
      let alleleFrequencyHtml = ``;
      let alleleNumberHtml = ``;
      let sourceHtml = ``;
      let svLength = ``;

      const fontStyle = `line-height: 12px;font-family: monospace;font-size:14px;`;

      for (const variant of filteredList) {
        const variantFrom = this._xScale(variant.from);
        const variantTo = this._xScale(variant.to);

        // draw outline
        const width = variantTo - variantFrom;

        this.mouseOverGraphics.lineStyle({
          width: 1,
          color: 0,
        });
        this.mouseOverGraphics.drawRect(
          variantFrom,
          variant.yTop,
          width,
          vHeight,
        );
        this.animate();

        let vRef = variant.ref.match(/.{1,15}/g).join('<br>');
        let vAlt = variant.alt.match(/.{1,15}/g).join('<br>');

        if(variant.category === "SNV"){
          variantHtml += `<td style='${fontStyle} padding-right:5px;'><strong>${vRef} &rarr; ${vAlt}</strong></td>`;
          positionHtml += `<td>${variant.chrName}:${
            variant.from - variant.chrOffset
          }</td>`;
          sourceHtml += `<td>gnomAD</td>`;
        } 
        else {
          variantHtml += `<td>Structural variant</td>`;
          positionHtml += `<td>${variant.chrName}:${
            variant.from - variant.chrOffset
          }-${variant.chrName}:${variant.to - variant.chrOffset}</td>`;
          sourceHtml += `<td>gnomAD-SV</td>`;
          svLength += `<td>${variant.info['SVLEN']}</td>`
        }

        typeHtml += `<td>${this.capitalizeFirstLetter(variant.type)}</td>`;
        alleleCountHtml += `<td>${variant.alleleCount}</td>`;
        const af = Number.parseFloat(variant.alleleFrequency).toExponential(4);
        alleleFrequencyHtml += `<td>${af}</td>`;
        alleleNumberHtml += `<td>${variant.alleleNumber}</td>`;
        
      }

      if (filteredList.length > 0) {
        let mouseOverHtml =
          `<table>` +
          `<tr><td>Variant:</td>${variantHtml}</tr>` +
          `<tr><td>Type:</td>${typeHtml}</tr>` +
          `<tr><td>Position:</td>${positionHtml}</tr>`;

          if(svLength.length > 0){
            mouseOverHtml += `<tr><td>SV length:</td>${svLength}</tr>`
          }

          mouseOverHtml +=
          `<tr><td>Allele Count:</td>${alleleCountHtml}</tr>` +
          `<tr><td>Allele Frequency:</td>${alleleFrequencyHtml}</tr>` +
          `<tr><td>Allele Number:</td>${alleleNumberHtml}</tr>` +
          `<tr><td>Source:</td>${sourceHtml}</tr>` +
          `</table>`;
   
        return sanitizeHtml(mouseOverHtml);
      }

      return '';
    }

    capitalizeFirstLetter(string) {
      return string.charAt(0).toUpperCase() + string.slice(1);
    }

    calculateZoomLevel() {
      return HGC.utils.trackUtils.calculate1DZoomLevel(
        this.tilesetInfo,
        this._xScale,
        this.maxZoom,
      );
    }

    calculateVisibleTiles() {
      const tiles = HGC.utils.trackUtils.calculate1DVisibleTiles(
        this.tilesetInfo,
        this._xScale,
      );

      for (const tile of tiles) {
        const { tileX, tileWidth } = getTilePosAndDimensions(
          tile[0],
          [tile[1]],
          this.tilesetInfo.tile_size,
          this.tilesetInfo,
        );

        const DEFAULT_MAX_TILE_WIDTH = this.options.maxTileWidth || 2e5;

        if (
          tileWidth > DEFAULT_MAX_TILE_WIDTH
        ) {
          this.errorTextText = 'Zoom in to see details';
          this.drawError();
          this.animate();
          return;
        }

        this.errorTextText = null;
        this.pBorder.clear();
        this.drawError();
        this.animate();
      }

      this.setVisibleTiles(tiles);
    }

    setPosition(newPosition) {
      super.setPosition(newPosition);

      [this.pMain.position.x, this.pMain.position.y] = this.position;
      [this.pMouseOver.position.x, this.pMouseOver.position.y] = this.position;

      [this.loadingText.x, this.loadingText.y] = newPosition;
      this.loadingText.x += 30;
    }

    movedY(dY) {
      const vst = this.valueScaleTransform;
      const height = this.dimensions[1];

      // clamp at the bottom and top
      if (
        vst.y + dY / vst.k > -(vst.k - 1) * height &&
        vst.y + dY / vst.k < 0
      ) {
        this.valueScaleTransform = vst.translate(0, dY / vst.k);
      }

      // this.segmentGraphics may not have been initialized if the user
      // was zoomed out too far
      if (this.segmentGraphics) {
        this.segmentGraphics.position.y = this.valueScaleTransform.y;
      }

      this.animate();
    }

    zoomedY(yPos, kMultiplier) {
      const newTransform = HGC.utils.trackUtils.zoomedY(
        yPos,
        kMultiplier,
        this.valueScaleTransform,
        this.dimensions[1],
      );

      this.valueScaleTransform = newTransform;
      this.segmentGraphics.scale.y = newTransform.k;
      this.segmentGraphics.position.y = newTransform.y;

      this.mouseOverGraphics.clear();
      this.animate();
    }

    zoomed(newXScale, newYScale) {
      super.zoomed(newXScale, newYScale);

      if (this.segmentGraphics) {
        scaleScalableGraphics(
          this.segmentGraphics,
          newXScale,
          this.drawnAtScale,
        );
      }

      this.mouseOverGraphics.clear();
      this.animate();
    }

    exportSVG() {
      let track = null;
      let base = null;

      if (super.exportSVG) {
        [base, track] = super.exportSVG();
      } else {
        base = document.createElement('g');
        track = base;
      }

      const output = document.createElement('g');
      track.appendChild(output);

      output.setAttribute(
        'transform',
        `translate(${this.pMain.position.x},${this.pMain.position.y}) scale(${this.pMain.scale.x},${this.pMain.scale.y})`,
      );

      const gSegment = document.createElement('g');

      gSegment.setAttribute(
        'transform',
        `translate(${this.segmentGraphics.position.x},${this.segmentGraphics.position.y})` +
          `scale(${this.segmentGraphics.scale.x},${this.segmentGraphics.scale.y})`,
      );

      output.appendChild(gSegment);

      if (this.segmentGraphics) {
        const b64string = HGC.services.pixiRenderer.plugins.extract.base64(
          // this.segmentGraphics, 'image/png', 1,
          this.pMain.parent.parent,
        );

        const gImage = document.createElement('g');

        gImage.setAttribute('transform', `translate(0,0)`);

        const image = document.createElement('image');
        image.setAttributeNS(
          'http://www.w3.org/1999/xlink',
          'xlink:href',
          b64string,
        );
        gImage.appendChild(image);
        gSegment.appendChild(gImage);

        // gSegment.appendChild(image);
      }

      return [base, base];
    }
  }

  return new GnomadTrackClass(...args);
};

const icon = '<svg width="16" height="16" xmlns="http://www.w3.org/2000/svg"> <!-- Created with Method Draw - http://github.com/duopixel/Method-Draw/ --> <g> <title>background</title> <rect fill="#fff" id="canvas_background" height="18" width="18" y="-1" x="-1"/> <g display="none" overflow="visible" y="0" x="0" height="100%" width="100%" id="canvasGrid"> <rect fill="url(#gridpattern)" stroke-width="0" y="0" x="0" height="100%" width="100%"/> </g> </g> <g> <title>Layer 1</title> <rect id="svg_1" height="0.5625" width="2.99997" y="3.21586" x="1.18756" stroke-width="1.5" stroke="#999999" fill="#000"/> <rect id="svg_3" height="0.5625" width="2.99997" y="7.71582" x="6.06252" stroke-width="1.5" stroke="#999999" fill="#000"/> <rect id="svg_4" height="0.5625" width="2.99997" y="3.21586" x="1.18756" stroke-width="1.5" stroke="#999999" fill="#000"/> <rect id="svg_5" height="0.5625" width="2.99997" y="3.90336" x="11.49997" stroke-width="1.5" stroke="#f73500" fill="#000"/> <rect id="svg_6" height="0.5625" width="2.99997" y="7.40333" x="11.62497" stroke-width="1.5" stroke="#999999" fill="#000"/> <rect id="svg_7" height="0.5625" width="2.99997" y="13.90327" x="5.93752" stroke-width="1.5" stroke="#f4f40e" fill="#000"/> </g> </svg>';

GnomadTrack.config = {
  type: 'gnomad',
  datatype: ['vcf'],
  orientation: '1d-horizontal',
  name: 'Gnomad Track',
  thumbnail: new DOMParser().parseFromString(icon, 'text/xml').documentElement,
  availableOptions: [
    'colorScale',
    'showMousePosition',
    'variantHeight',
    'maxTileWidth'
    // 'minZoom'
  ],
  defaultOptions: {
    colorScale: [
      // Variant, Insertion, Deletion, Inversion, Duplication
      [0.3, 0.3, 0.3, 0.6],
      [0.6, 0.6, 0.0, 0.7],
      [1, 0.0, 0.0, 0.55],
      [0.68, 0.23, 0.87, 0.8],
      [0.27, 0.64, 0.09, 0.8]
    ],
    showMousePosition: false,
    variantHeight: 12,
    maxTileWidth: 2e5
  },
  optionsInfo: {
    
    colorScale: {
      name: 'Color scheme',
      inlineOptions: {
        default: {
          value: [
            // Variant, Insertion, Deletion, Inversion, Duplication
            [0.3, 0.3, 0.3, 0.6],
            [0.6, 0.6, 0.0, 0.7],
            [1, 0.0, 0.0, 0.55],
            [0.68, 0.23, 0.87, 0.8],
            [0.27, 0.64, 0.09, 0.8]
          ],
          name: 'Default',
        },
      },
    },
  },
};

export default GnomadTrack;
