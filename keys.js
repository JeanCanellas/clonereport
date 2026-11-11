'use strict';
// Developer keys ("Supercell Oy" -> "supercell-oy") group every report about one studio.
const devKey = (name) => String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || null;
module.exports = { devKey };
