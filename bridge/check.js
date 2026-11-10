'use strict';

/**
 * Smoke check of the bridge: health, runtime config and the served app shell.
 * Run with: node bridge/check.js
 */

const BASE = process.env.BRIDGE_URL || 'http://127.0.0.1:8787';

const get = async (path) => {
    const response = await fetch(BASE + path);
    return { response, text: await response.text() };
};

(async () => {
    const health = await get('/api/health');
    console.log('GET /api/health ->', health.response.status);
    console.log('  qbittorrent:', JSON.stringify(JSON.parse(health.text).qbittorrent));
    console.log('  staticReady:', JSON.parse(health.text).staticReady);

    const config = await get('/config.js');
    console.log('GET /config.js ->', config.response.status, config.text.trim());

    const index = await get('/');
    console.log('GET /            ->', index.response.status, `(${index.text.length} bytes)`);
    console.log('  config script injected:', index.text.includes('/config.js'));

    const scripts = index.text.match(/<script[^>]*src="[^"]*"/g) || [];
    const links = index.text.match(/<link[^>]*href="[^"]*"/g) || [];
    console.log('  scripts:', scripts.filter((tag) => !tag.includes('gstatic') && !tag.includes('appleid')).join(' | '));
    console.log('  styles:', links.filter((tag) => tag.includes('css')).join(' | '));

    const wasm = index.text.match(/[a-f0-9]{40}\/binaries\/[a-z_]+\.wasm/);
    console.log('  wasm ref:', wasm ? wasm[0] : 'none');

    const manifest = await get('/manifest.json');
    console.log('GET /manifest.json ->', manifest.response.status);

    const notFound = await get('/does-not-exist');
    console.log('GET /does-not-exist ->', notFound.response.status, '(SPA fallback)');
})();
