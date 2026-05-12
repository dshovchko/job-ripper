import {readFileSync} from 'node:fs';
import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import {visit} from 'unist-util-visit';

// Create our own plugin for AST tree manipulation
function myAstManipulator() {
  return (tree) => {
    // 1. Text Mutation: UPPERCASE all text nodes (increases CPU usage)
    visit(tree, 'text', (node) => {
      if (node.value) {
        node.value = node.value.toUpperCase();
      }
    });

    // 2. Structural Mutation: "shake the branches"
    // Find all headings and insert new objects (paragraph + image) right after them
    // This forces the V8 engine to constantly expand and shift arrays (array.splice) in memory
    visit(tree, 'heading', (node, index, parent) => {
      if (parent && typeof index === 'number') {
        const injectedAd = {
          type: 'paragraph',
          children: [
            {type: 'text', value: '🚀 Processed lightning fast by '},
            {type: 'strong', children: [{type: 'text', value: 'job-ripper'}]},
            {type: 'text', value: ' '},
            {type: 'image', url: 'https://example.com/logo.png', alt: 'job-ripper logo image'}
          ]
        };

        // Insert right after the current heading
        parent.children.splice(index + 1, 0, injectedAd);

        // Tell `visit` to skip our newly inserted element
        // to avoid an infinite loop or duplicated processing
        return index + 2;
      }
    });
  };
}

// Initialize the processor once per worker
const processor = unified()
  .use(remarkParse)         // String -> Markdown AST (mdast)
  .use(myAstManipulator)    // Our AST manipulation
  .use(remarkRehype)        // Markdown AST -> HTML AST (hast)
  .use(rehypeStringify);    // HTML AST -> String (HTML)

export default async function (file) {
  try {
    const md = readFileSync(file, 'utf-8');
    // Execute a full cycle of parsing, tree traversal, and HTML generation
    const result = processor.processSync(md);
    // stringResult is the generated HTML, which we discard in this benchmark
    const stringResult = String(result);
  } catch (err) {
    // Ignore parsing errors from broken or malformed files
  }
}
