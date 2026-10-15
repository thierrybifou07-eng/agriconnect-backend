import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

function envInit() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    const envLocalPath = resolve(__dirname, '../.env.local')

    if (existsSync(envLocalPath)) dotenv.config({
        path: resolve(__dirname, '../.env.local')
    })

    dotenv.config({
        path: resolve(__dirname, '../.env')
    })
}

envInit()