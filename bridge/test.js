'use strict';

/**
 * Unit checks for the magnet helpers and the file picker.
 * Run with: node bridge/test.js
 */

const assert = require('assert');

const {
    buildMagnet,
    displayNameFromMagnet,
    infoHashFromMagnet,
    normalizeInfoHash,
    pickTargetFile,
    trackersFromMagnet,
} = require('./lib/magnet');

const HEX = 'df389295484b3059a4726dc6d8a57f71bb5f4c81';
const BASE32 = '344JFFKIJMYFTJDSNXDNRJL7OG5V6TEB';

assert.strictEqual(normalizeInfoHash(HEX), HEX);
assert.strictEqual(normalizeInfoHash(HEX.toUpperCase()), HEX);
assert.strictEqual(normalizeInfoHash(BASE32), HEX, 'base32 info hash must decode to hex');
assert.strictEqual(normalizeInfoHash('not-a-hash'), null);

const magnet = buildMagnet({
    infoHash: HEX,
    trackers: ['tracker:udp://tracker.example.com:1337/announce', 'udp://other/announce'],
    name: 'Some Movie 2024 1080p',
});

assert.ok(magnet.startsWith('magnet:?'), 'magnet must start with magnet:?');
assert.ok(magnet.includes(`xt=urn:btih:${HEX}`), 'magnet must carry the info hash');
assert.ok(magnet.includes('dn=Some%20Movie%202024%201080p'), 'magnet must carry the name');
assert.ok(!magnet.includes('tracker:udp'), 'the tracker: prefix must be stripped');
assert.ok(magnet.includes('tr=udp%3A%2F%2Ftracker.example.com%3A1337%2Fannounce'), 'tracker must be encoded');

assert.strictEqual(infoHashFromMagnet(magnet), HEX);
assert.strictEqual(displayNameFromMagnet(magnet), 'Some Movie 2024 1080p');
assert.deepStrictEqual(trackersFromMagnet(magnet), [
    'udp://tracker.example.com:1337/announce',
    'udp://other/announce',
]);

assert.strictEqual(infoHashFromMagnet('magnet:?xt=urn:btih:' + BASE32), HEX);
assert.strictEqual(infoHashFromMagnet('https://example.com/file.mkv'), null);

// The magnet Stremio's core builds for a torrent stream.
const coreMagnet = `magnet:?dn=Some%20Movie&xt=urn:btih:${HEX}&tr=udp%3A%2F%2Ftracker.example.com%3A1337%2Fannounce`;
assert.strictEqual(infoHashFromMagnet(coreMagnet), HEX);
assert.strictEqual(trackersFromMagnet(coreMagnet).length, 1);

const files = [
    { index: 0, name: 'Some.Movie.2024/sample.mkv', size: 500 },
    { index: 1, name: 'Some.Movie.2024/Some.Movie.2024.1080p.mkv', size: 8000 },
    { index: 2, name: 'Some.Movie.2024/readme.txt', size: 20 },
];

assert.strictEqual(pickTargetFile(files, 2, []).index, 2, 'fileIdx wins');
assert.strictEqual(pickTargetFile(files, null, ['1080p.mkv']).index, 1, 'fileMustInclude is matched');
assert.strictEqual(pickTargetFile(files, null, ['nothing-here']).index, 1, 'falls back to the largest file');
assert.strictEqual(pickTargetFile(files, null, []).index, 1, 'no hints means the largest file');
assert.strictEqual(pickTargetFile([], 0, []), null, 'no files, no target');

// A file index that does not exist must not explode.
assert.strictEqual(pickTargetFile(files, 99, []).index, 1, 'unknown fileIdx falls back');

console.log('All magnet / file picker checks passed.');
