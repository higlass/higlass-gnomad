import register from 'higlass-register';

import GnomadTrack from './GnomadTrack';

register({
  name: 'GnomadTrack',
  track: GnomadTrack,
  config: GnomadTrack.config,
});
