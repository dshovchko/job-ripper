import {readFileSync} from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

// Read schema once per worker initialization
const schemaData = readFileSync(new URL('./schema.json', import.meta.url), 'utf-8');
const schema = JSON.parse(schemaData);

const ajv = new Ajv({strict: false, allErrors: true});
addFormats(ajv);

const dummySchemas = [
  'https://json.schemastore.org/eslintrc.json',
  'https://json.schemastore.org/stylelintrc.json',
  'https://json.schemastore.org/ava.json',
  'https://json.schemastore.org/semantic-release.json',
  'https://json.schemastore.org/jscpd.json',
  'https://json.schemastore.org/nodemon.json',
  'https://www.schemastore.org/prettierrc.json'
];
for (const id of dummySchemas) {
  ajv.addSchema({$id: id});
}

const validate = ajv.compile(schema);

export default async function(file) {
  try {
    const data = readFileSync(file, 'utf-8');
    const json = JSON.parse(data);
    // Execute validation (CPU bound + memory alloc)
    validate(json);
  } catch (err) {
    // Ignore malformed JSON files found in some random node_modules sub-folders
  }
}
