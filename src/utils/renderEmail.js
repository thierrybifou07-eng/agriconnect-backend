import ejs from 'ejs';
import juice from 'juice';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, '../emails/templates');

// Rend un template EJS puis inline le CSS (<style> -> style="...") pour la
// compatibilité avec les clients email, qui ignorent majoritairement les balises <style>.
export async function renderEmail(templateName, data) {
  const filePath = path.join(TEMPLATES_DIR, `${templateName}.ejs`);
  const html = await ejs.renderFile(filePath, data);
  return juice(html);
}
