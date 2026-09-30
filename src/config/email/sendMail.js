import ejs from 'ejs'
import { resolve } from 'node:path'
import juice from 'juice'
import { readFile } from 'fs/promises'
import { existsSync } from "node:fs"
import transport from "./transport.js";
//import '../../../config/env.js'

async function getHtmlContent(template, props = {}) {
    const basePath = `views/emails/${template}/email.`
    const templatePath = resolve(`${basePath}ejs`)
    const cssFiles = []
    const sharedCssPath = resolve('views/emails/_shared/style.css')
    if (existsSync(sharedCssPath)) cssFiles.push(sharedCssPath)
    const cssPath = resolve(`${basePath}css`)
    if (existsSync(cssPath)) cssFiles.push(cssPath)
    const htmlContent = await ejs.renderFile(templatePath, props)
    if (cssFiles.length > 0) {
        const cssContent = await Promise.all(cssFiles.map(file => readFile(file, 'utf8')))
        const combinedCss = cssContent.join('\n')
        return juice.inlineContent(htmlContent, combinedCss)
    }
    return htmlContent
}
// Neutralisation pour les tests : aucun envoi reel ne doit partir depuis une
// base de test, et aucune connexion SMTP ne doit etre tentee.
const isDisabled = () => process.env.SMTP_DISABLED === '1';

export const sendTemplateEmail = async (to, subject, template, props = {}) => {
    if (isDisabled()) {
        console.log(`[mail] envoi ignore (SMTP_DISABLED) : "${subject}" a ${to}`);
        return null;
    }

    const html = await getHtmlContent(template, props)
    const mailOptions = {
        from: process.env.EMAIL_SENDER,
        to,
        subject,
        html // Utiliser le contenu HTML rendu
    };

    await transport.sendMail(mailOptions);
};

export const sendEmail = async (userEmail, subject, message) => {
    if (isDisabled()) {
        console.log(`[mail] envoi ignore (SMTP_DISABLED) : "${subject}" a ${userEmail}`);
        return null;
    }

    const mailOptions = {
        from: process.env.EMAIL_SENDER,
        to: userEmail,
        subject: subject,
        text: message
    }

    await transport.sendMail(mailOptions)
}