export default async function(filePath) {
  return new Promise(resolve => setTimeout(() => resolve('ok'), 20));
}
