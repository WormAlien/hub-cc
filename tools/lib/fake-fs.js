'use strict';
// Синтетический корень в памяти: адаптер обязан принимать fs снаружи, иначе его нельзя
// проверить без живых данных и он не переносим между машинами.
function makeFs(files) {
    const map = new Map(Object.entries(files));
    const dirs = new Set();
    for (const p of map.keys()) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    return {
        readFileSync: p => {
            if (!map.has(p)) { const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; }
            return Buffer.from(map.get(p), 'utf8');
        },
        statSync: p => {
            if (map.has(p)) return { size: Buffer.byteLength(map.get(p)), mtimeMs: 1 };
            if (dirs.has(p)) return { size: 0, mtimeMs: 1, isDirectory: () => true };
            const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e;
        },
        readdirSync: p => {
            const out = new Set();
            for (const k of map.keys()) if (k.startsWith(p + '/')) out.add(k.slice(p.length + 1).split('/')[0]);
            for (const d of dirs) if (d.startsWith(p + '/')) out.add(d.slice(p.length + 1).split('/')[0]);
            return [...out];
        },
    };
}
module.exports = { makeFs };
