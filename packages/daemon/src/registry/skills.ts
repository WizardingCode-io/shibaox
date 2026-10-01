/** A repository of skills the Discover tab offers (its listing comes from `GET /skills/discover`). */
export interface SkillSource {
  repo: string;
  name: string;
  vendor: string;
  description: string;
  /** Where the skills live inside the repository. */
  path?: string;
  /** Categories (the folder names of the repository, when it groups by folder). */
  categories?: string[];
}

const SOURCES: SkillSource[] = [
  {
    repo: 'anthropics/skills',
    name: 'Anthropic skills',
    vendor: 'Anthropic',
    description:
      'Anthropic’s public skills: documents (docx, pdf, pptx, xlsx), design, development, communication.',
    path: 'skills',
    categories: ['Documents', 'Design', 'Development', 'Communication'],
  },
  {
    repo: 'higgsfield-ai/skills',
    name: 'Higgsfield skills',
    vendor: 'Higgsfield',
    description: 'Generation recipes for Higgsfield: images, video, product shots, characters.',
    categories: ['Design & media'],
  },
];

export function skillSources(): SkillSource[] {
  return SOURCES.map((s) => ({ ...s, ...(s.categories ? { categories: [...s.categories] } : {}) }));
}
