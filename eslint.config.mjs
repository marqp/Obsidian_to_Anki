import js from '@eslint/js'
import tsPlugin from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'

export default tsPlugin.config(
	{
		ignores: [
			'main.js',
			'node_modules/**',
			'dist/**',
			'build/**',
			'logs/**',
			'coverage/**',
			'.stryker-tmp/**',
			'reports/**',
			'tests/defaults/**',
			'tests/mocks/**',
			'tests/anki/**',
			'tests/specs/**',
			'tests/parity/**',
			'wdio.conf.ts',
			'prepare-wdio.sh',
			'*.js'
		]
	},
	js.configs.recommended,
	...tsPlugin.configs.recommended,
	prettierConfig,
	{
		files: ['src/**/*.ts', 'main.ts'],
		rules: {
			// Regra 1: Evitar tipos `any` soltos que mascaram erros de tipagem em runtime.
			'@typescript-eslint/no-explicit-any': 'error',
			// Regra 2: Non-null assertions devem ser tratadas com cuidado ou guardas defensivas.
			'@typescript-eslint/no-non-null-assertion': 'warn',
			// Regra 3: Variáveis não reatribuídas devem ser constantes para imutabilidade.
			'prefer-const': 'error',
			// Regra 4: Variáveis não utilizadas devem ser prefixadas com _ para declarar intenção.
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_'
				}
			],
			// Permitir hasOwnProperty em objetos literais sem forçar Object.hasOwn em ES2020
			'no-prototype-builtins': 'off',
			// Permitir atribuições defensivas intermediárias
			'no-useless-assignment': 'off'
		}
	},
	{
		files: ['tests/**/*.ts', '*.mjs'],
		languageOptions: {
			globals: {
				process: 'readonly',
				console: 'readonly'
			}
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			],
			'no-prototype-builtins': 'off',
			'no-useless-assignment': 'off'
		}
	}
)
