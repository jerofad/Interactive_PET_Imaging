/* Loads the synthetic brain phantom: 128 × 128 × 96 uint8 activity followed by uint8 tissue labels.
   The file is gzip-compressed (~100 KB instead of ~4 MB of base64 in the original page). */
import { gunzipSync } from 'fflate';
import meta from '../data/phantom.json';
import volumeUrl from '../data/phantom.u8.gz?url';

const VOXELS = 128 * 128 * 96;
let pending = null;

export function loadPhantom() {
  if (!pending) pending = fetchPhantom();
  return pending;
}

async function fetchPhantom() {
  const response = await fetch(volumeUrl);
  if (!response.ok) throw Error('Phantom data request failed (' + response.status + ').');
  let bytes = new Uint8Array(await response.arrayBuffer());
  // Some hosts decompress .gz transparently; only inflate when the gzip magic number is present.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  if (bytes.length !== 2 * VOXELS) throw Error('Phantom data size mismatch.');
  return { meta, volume: bytes.subarray(0, VOXELS), tissue: bytes.subarray(VOXELS) };
}
