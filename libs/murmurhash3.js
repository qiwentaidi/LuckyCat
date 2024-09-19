/**
 * MurmurHash3 x86 32-bit JavaScript Implementation
 * 
 * This file contains a JavaScript implementation of the MurmurHash3 algorithm 
 * (x86 32-bit version), suitable for hashing string data.
 * The implementation provides a signed 32-bit hash value.
 *
 * This implementation is based on the MurmurHash3 Python module by Hajime Senuma.
 * Reference: https://github.co
 * m/hajimes/mmh3
 * 
 * MurmurHash is a non-cryptographic hash function suitable for general hash-based 
 * lookup. 
 * 
 * Usage:
 *   - Function `mmh3_32` takes a string input and an optional seed (default is 0).
 *   - It returns a signed 32-bit integer hash.
 * 
 * Note: This implementation is specifically designed for hashing string.
 * 
 * Example:
 *   let hash = mmh3_32('your_string_here');
 *   console.log(hash); // Outputs the signed 32-bit hash
 * 
 * Author: Michael Knap
 * License: MIT
 */
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0; // Return as signed 32-bit integer
}

function rotl32(x, r) {
  return (x << r) | (x >>> (32 - r));
}

function string_to_uint8_array(str) {
  const utf8Encoder = new TextEncoder();
  return utf8Encoder.encode(str);
}

function mmh3_32(key, seed = 0) {
  let data;
  if (typeof key === 'string') {
    data = string_to_uint8_array(key);

  } else if (key instanceof Uint8Array) {
    data = key;
  } else {
    throw new Error('Key must be a string or Uint8Array');
  }

  let len = data.length;
  let nblocks = len >> 2;

  let h1 = seed | 0;

  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  // Body
  let blocks = new Uint32Array(data.buffer, data.byteOffset, nblocks);

  for (let i = 0; i < nblocks; i++) {
    let k1 = blocks[i];

    k1 = Math.imul(k1, c1);
    k1 = rotl32(k1, 15);
    k1 = Math.imul(k1, c2);

    h1 ^= k1;
    h1 = rotl32(h1, 13);
    h1 = Math.imul(h1, 5) + 0xe6546b64;
  }

  // Tail
  const tail = new Uint8Array(data.buffer, data.byteOffset + nblocks * 4);

  let k1 = 0;

  switch (len & 3) {
    case 3:
      k1 ^= tail[2] << 16;
    case 2:
      k1 ^= tail[1] << 8;
    case 1:
      k1 ^= tail[0];
      k1 = Math.imul(k1, c1);
      k1 = rotl32(k1, 15);
      k1 = Math.imul(k1, c2);
      h1 ^= k1;
  }

  // Finalization
  h1 ^= len;

  h1 = fmix32(h1);

  return h1; // Return as signed 32-bit integer
}

