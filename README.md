

# Display gnomAD allele frequencies in HiGlass

![gnomAd](https://user-images.githubusercontent.com/53857412/101543387-297c5080-3972-11eb-8d79-f867c4cbf262.png)


**Note**: This is the source code for the gnomAD track only! You might want to check out the following repositories as well:

- HiGlass viewer: https://github.com/higlass/higlass
- HiGlass server: https://github.com/higlass/higlass-server
- HiGlass docker: https://github.com/higlass/higlass-docker

## Installation
 
```
npm install higlass-gnomad
```

## Data preparation

This track uses vcf files as input data. Here is an example of entries that can be consumed by this track:

```
#CHROM	POS	ID	REF	ALT	QUAL	FILTER	INFO
chr21   5030240 rs1185110752    AC      A       .       PASS    AC=16;AN=3778;AF=0.00423504;AF_popmax=0.0296296
chr21   5030242 .       C       T       .       AC0;AS_VQSR     AC=0;AN=3832;AF=0.00000
chr21   5030249 .       T       C       .       AC0;AS_VQSR     AC=0;AN=4630;AF=0.00000
chr21   5030253 rs1486393480    G       T       .       AS_VQSR AC=1;AN=5170;AF=0.000193424;AF_popmax=0.000426621
chr21   5030262 .       C       A       .       AC0;AS_VQSR     AC=0;AN=6230;AF=0.00000
chr21   5030275 .       A       G       .       AC0;AS_VQSR     AC=0;AN=7910;AF=0.00000
```
Note that `AC` (allele count),`AN` (allele number) and `AF` (allele frequency) is required in the INFO column.

## Usage

The live scripts can be found at:

- https://unpkg.com/higlass-pileup/dist/higlass-gnomad.min.js
- https://unpkg.com/higlass-pileup/dist/0.higlass-gnomad.min.worker.js

Note that `higlass-gnomad` currently requires a worker thread. It'll automatically try to retrieve it from the same path as the main script but it needs to be hosted on the same server. The current recommended solution is to pull the already built js files from a release and have your web server serve them from the same path. If you need the worker script to be in a different location than the main script (on the same server), you can use the option `workerScriptLocation` to specify that location.

### Client

1. Load this track before the HiGlass core script. For example:

```
<script src="/higlass-gnomad.js"></script>
<script src="hglib.js"></script>

<script>
  ...
</script>
```

### Options
The following options are available:
```
{
  "uid": "some_uid",
  "type": "gnomad",
  "options": {
    "colorScale": [
      [0.3, 0.3, 0.3, 0.6],// Variant color in RGBA format
      [0.6, 0.6, 0.0, 0.7],// Insertion color in RGBA format
      [1, 0.0, 0.0, 0.6],// Deletion color in RGBA format
    ],
    "showMousePosition": false,
    "workerScriptLocation": null, // see 'Usage'
    "variantHeight": 12, // Height of the rectangles
  },
  "data": {
    "type": "vcf",
    "vcfUrl": "https://url_to_your_vcf/gnomad.vcf.gz",
    "tbiUrl": "https://url_to_your_vcf/gnomad.vcf.gz.tbi",
    "chromSizesUrl": "https://url_to_your_chromsize_file/chrom.sizes",
  },
  "width": 768,
  "height": 200
}
```

### ECMAScript Modules (ESM)

We also build out ES modules for usage by applications who may need to import or use `higlass-gnomad` as a component.

Whenever there is a statement such as the following, assuming `higlass-gnomad` is in your node_modules folder:
```javascript
import { GnomadTrack } from 'higlass-gnomad';
```

Then GnomadTrack would automatically be imported from the `./es` directory (set via package.json's `"module"` value). 

## Support

For questions, please either open an issue or ask on the HiGlass Slack channel at http://bit.ly/higlass-slack

## Development

### Installation

```bash
$ git clone https://github.com/higlass/higlass-gnomad.git
$ cd higlass-gnomad
$ npm install
```
If you have a local copy of higlass, you can then run this command in the higlass-gnomad directory:

```bash
npm link higlass
```

### Commands

 - **Developmental server**: `npm start`
 - **Production build**: `npm run build`


