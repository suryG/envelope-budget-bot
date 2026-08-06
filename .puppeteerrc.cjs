const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // מגדיר ל-Puppeteer להתקין ולחפש את Chrome בתוך node_modules 
  // כך שהוא יישמר בוודאות בדיפלוי של Render!
  cacheDirectory: join(__dirname, 'node_modules', '.cache', 'puppeteer'),
};