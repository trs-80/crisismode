import { runDemo } from './demo/runner.js';

runDemo().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
