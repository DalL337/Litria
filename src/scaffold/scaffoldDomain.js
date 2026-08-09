const SCAFFOLD_REGISTRY = {
  javascript: {
    id: 'javascript',
    name: 'JavaScript',
    packageManager: 'npm',
    frameworks: [{ id: 'node', name: 'Node.js' }],
    coreDependencies: {
      node: []
    },
    addons: []
  },
  typescript: {
    id: 'typescript',
    name: 'TypeScript',
    packageManager: 'npm',
    frameworks: [{ id: 'node', name: 'Node.js + TypeScript' }],
    coreDependencies: {
      node: ['typescript', 'tsx', '@types/node']
    },
    addons: []
  },
  python: {
    id: 'python',
    name: 'Python',
    packageManager: 'pip',
    frameworks: [{ id: 'python', name: 'Python Service' }],
    coreDependencies: {
      python: [
        'python-dotenv==1.0.0',
        'pytest==7.2.2',
        'black==23.1.0',
        'flake8==6.0.0'
      ]
    },
    addons: []
  },
  json: {
    id: 'json',
    name: 'JSON',
    packageManager: 'none',
    frameworks: [{ id: 'config', name: 'Config Bundle' }],
    coreDependencies: {
      config: []
    },
    addons: []
  }
};

function toInstallCommand(packageManager, dependencies) {
  if (!dependencies.length) return '';
  if (packageManager === 'npm') return `npm install ${dependencies.join(' ')}`;
  if (packageManager === 'pip') return `pip install ${dependencies.join(' ')}`;
  return '';
}

function unique(items) {
  return [...new Set(items)];
}

function getBaseFiles(languageId, frameworkId) {
  const byLanguage = {
    javascript: {
      node: ['package.json', 'src/index.js', '.env.example', '.gitignore', 'README.md']
    },
    typescript: {
      node: ['package.json', 'tsconfig.json', 'src/index.ts', '.env.example', '.gitignore', 'README.md']
    },
    python: {
      python: ['requirements.txt', 'src/main.py', 'tests/test_main.py', '.env.example', '.gitignore', 'README.md']
    },
    json: {
      config: ['config/settings.json', '.gitignore', 'README.md']
    }
  };

  return byLanguage[languageId]?.[frameworkId] ?? [];
}

function getCoreFiles(languageId, frameworkId) {
  const byLanguage = {
    javascript: {
      node: ['package.json', 'src/index.js']
    },
    typescript: {
      node: ['package.json', 'tsconfig.json', 'src/index.ts']
    },
    python: {
      python: ['requirements.txt', 'src/main.py']
    },
    json: {
      config: ['config/settings.json']
    }
  };

  return byLanguage[languageId]?.[frameworkId] ?? [];
}

function getEntryFile(languageId, frameworkId) {
  const entries = {
    javascript: {
      node: 'src/index.js'
    },
    typescript: {
      node: 'src/index.ts'
    },
    python: {
      python: 'src/main.py'
    },
    json: {
      config: null
    }
  };

  return entries[languageId]?.[frameworkId] ?? null;
}

export function getScaffoldLanguages() {
  return Object.values(SCAFFOLD_REGISTRY);
}

export function getScaffoldFrameworks(languageId) {
  return SCAFFOLD_REGISTRY[languageId]?.frameworks ?? [];
}

export function getScaffoldAddons(languageId) {
  const addonIds = SCAFFOLD_REGISTRY[languageId]?.addons ?? [];
  return addonIds.map((addonId) => ({ id: addonId, name: addonId }));
}

export function buildScaffoldPlan({
  projectName,
  languageId,
  frameworkId,
  addonIds = []
}) {
  const language = SCAFFOLD_REGISTRY[languageId];
  if (!language) {
    throw new Error(`Unknown language: ${languageId}`);
  }

  const framework = language.frameworks.find((entry) => entry.id === frameworkId);
  if (!framework) {
    throw new Error(`Unknown framework for ${language.name}: ${frameworkId}`);
  }

  // MVP: add-ons intentionally disabled while the scaffold surface is hardened.
  const selectedAddonIds = addonIds.filter(() => false);

  const dependencies = unique([
    ...(language.coreDependencies[framework.id] ?? [])
  ]);

  const files = unique([
    ...getBaseFiles(language.id, framework.id)
  ]);
  const coreFiles = unique([
    ...getCoreFiles(language.id, framework.id)
  ]);
  const entryFile = getEntryFile(language.id, framework.id);
  const connections = [];
  if (entryFile) {
    const entryDir = entryFile.includes('/') ? entryFile.split('/').slice(0, -1).join('/') : '';
    coreFiles.forEach((file) => {
      if (file === entryFile) return;
      const fileDir = file.includes('/') ? file.split('/').slice(0, -1).join('/') : '';
      if (fileDir === entryDir) {
        connections.push({ from: entryFile, to: file, type: 'reference' });
      }
    });
  }

  return {
    projectName: projectName.trim(),
    languageId: language.id,
    languageName: language.name,
    frameworkId: framework.id,
    frameworkName: framework.name,
    addons: selectedAddonIds,
    dependencies,
    installCommand: toInstallCommand(language.packageManager, dependencies),
    files,
    coreFiles,
    connections
  };
}

export function createScaffoldDomain() {
  return {
    commands: {
      buildPlan: buildScaffoldPlan
    },
    selectors: {
      getLanguages: getScaffoldLanguages,
      getFrameworks: getScaffoldFrameworks,
      getAddons: getScaffoldAddons
    }
  };
}
