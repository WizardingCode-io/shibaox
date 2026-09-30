import { createRoot } from 'react-dom/client';
import { loadDesignSystem } from './ds.js';

// the design system must be on the page before any screen renders
loadDesignSystem().then((S) => {
  const root = document.getElementById('root');
  if (!root) throw new Error('no #root');
  createRoot(root).render(<S.Mascot size={64} label="Shibaox" />);
});
