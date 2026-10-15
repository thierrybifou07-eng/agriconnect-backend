import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import './env.js'

const env = process.argv[2] || 'dev'

const envPath = path.resolve(env === 'prod' ? '.env' : `.env.local`);
const secretKey = crypto.randomBytes(32).toString('hex'); // 64 caractères hex

const keyName = 'JWT_SECRET';

let envContent = '';

if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf-8');

    // Supprime l'ancienne ligne si elle existe
    envContent = envContent
        .split('\n')
        .filter(line => !line.startsWith(`${keyName}=`))
        .join('\n');
}

// Ajoute la nouvelle clé à la fin
envContent += `${envContent && !envContent.endsWith('\n') ? '\n' : ''}${keyName}=${secretKey}\n`;

fs.writeFileSync(envPath, envContent);

console.log(`✅ Clé secrète générée et stockée dans .env :
${keyName}=${secretKey}`);
