// ============================================================
// Skills — Load and manage SKILL.md files
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';
import { agentConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { eventBus } from '../events.js';
import { registerTool } from '../tools/registry.js';
import type { SkillManifest } from '../types.js';

const log = createLogger('Skills');

const loadedSkills = new Map<string, SkillManifest>();

// ---- Skill Loading -------------------------------------------

export async function loadSkills(): Promise<SkillManifest[]> {
  const skillsDir = path.join(agentConfig.workspace, 'skills');
  await fs.mkdir(skillsDir, { recursive: true });

  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const skills: SkillManifest[] = [];

  for (const entry of entries) {
    // Each skill can be a standalone SKILL.md or a directory with SKILL.md inside
    let skillPath: string;
    if (entry.isDirectory()) {
      skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
    } else if (entry.name.endsWith('.md')) {
      skillPath = path.join(skillsDir, entry.name);
    } else {
      continue;
    }

    try {
      const skill = await parseSkillFile(skillPath);
      if (skill) {
        loadedSkills.set(skill.name, skill);
        skills.push(skill);
        eventBus.emit({ type: 'skill_loaded', skill });
        log.info(`Loaded skill: ${skill.name} — ${skill.description.slice(0, 60)}`);
      }
    } catch (err) {
      log.warn(`Failed to load skill from ${skillPath}: ${err}`);
    }
  }

  log.info(`Loaded ${skills.length} skills`);
  return skills;
}

async function parseSkillFile(filePath: string): Promise<SkillManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  // Parse YAML frontmatter
  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  let frontmatter: Record<string, any> = {};
  let instructions: string;

  if (frontmatterMatch) {
    try {
      frontmatter = YAML.parse(frontmatterMatch[1]) || {};
    } catch {
      log.warn(`Invalid YAML frontmatter in ${filePath}`);
    }
    instructions = frontmatterMatch[2].trim();
  } else {
    // No frontmatter — treat the whole file as instructions
    instructions = raw.trim();
    frontmatter.name = path.basename(filePath, '.md').replace('SKILL', '').replace(/^[-_]/, '') || 'unnamed';
  }

  return {
    name: frontmatter.name || path.basename(path.dirname(filePath)),
    description: frontmatter.description || instructions.slice(0, 200),
    version: frontmatter.version,
    author: frontmatter.author,
    tools: frontmatter.tools || [],
    triggers: frontmatter.triggers || [],
    instructions,
    filePath,
  };
}

// ---- Skill Context for System Prompt -------------------------

export function getSkillsContext(): string {
  if (loadedSkills.size === 0) return '';

  const skillBlocks = Array.from(loadedSkills.values()).map(s => [
    `### ${s.name}`,
    s.description,
    '',
    s.instructions,
  ].join('\n'));

  return [
    '## Available Skills',
    '',
    'You have the following skills loaded. Use them when relevant:',
    '',
    ...skillBlocks,
  ].join('\n');
}

export function getSkill(name: string): SkillManifest | undefined {
  return loadedSkills.get(name);
}

export function getAllSkills(): SkillManifest[] {
  return Array.from(loadedSkills.values());
}

// ---- Register skill management tool --------------------------

registerTool(
  {
    name: 'list_skills',
    description: 'List all loaded skills and their descriptions.',
    parameters: { type: 'object', properties: {} },
  },
  async () => {
    const skills = getAllSkills();
    if (skills.length === 0) return 'No skills loaded. Create SKILL.md files in the workspace/skills directory.';
    return skills.map(s =>
      `• ${s.name}: ${s.description.slice(0, 120)}`
    ).join('\n');
  },
);

registerTool(
  {
    name: 'create_skill',
    description: 'Create a new skill by writing a SKILL.md file with YAML frontmatter and natural-language instructions.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name (used as filename)' },
        description: { type: 'string', description: 'Short description' },
        instructions: { type: 'string', description: 'Detailed instructions for the skill' },
        triggers: { type: 'array', items: { type: 'string' }, description: 'Keywords that activate this skill' },
      },
      required: ['name', 'description', 'instructions'],
    },
  },
  async (input) => {
    const skillsDir = path.join(agentConfig.workspace, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    const frontmatter = YAML.stringify({
      name: input.name,
      description: input.description,
      triggers: input.triggers || [],
      version: '1.0.0',
    });

    const content = `---\n${frontmatter}---\n\n${input.instructions}`;
    const filePath = path.join(skillsDir, `${input.name}.md`);
    await fs.writeFile(filePath, content);

    // Reload
    const skill = await parseSkillFile(filePath);
    if (skill) {
      loadedSkills.set(skill.name, skill);
      eventBus.emit({ type: 'skill_loaded', skill });
    }

    return `Created skill "${input.name}" at ${filePath}`;
  },
);
