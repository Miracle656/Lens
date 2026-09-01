import { readFileSync, writeFileSync } from 'node:fs'
import YAML from 'js-yaml'

const sourcePath = new URL('../openapi.yaml', import.meta.url)
const destinationPath = new URL('../openapi.json', import.meta.url)
const contents = readFileSync(sourcePath, 'utf8')
const document = YAML.load(contents)
writeFileSync(destinationPath, JSON.stringify(document, null, 2) + '\n')
console.log('Generated openapi.json')
