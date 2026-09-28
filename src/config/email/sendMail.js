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
export const sendTemplateEmail = async (to, subject, template, props = {}) => {
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
    const mailOptions = {
        from: process.env.EMAIL_SENDER,
        to: userEmail,
        subject: subject,
        text: message
    }

    await transport.sendMail(mailOptions)
}