// SPDX-License-Identifier: GPL-3.0-or-later

// The rules GNOME Shell lints its own JavaScript with.
import {defineConfig} from 'eslint/config';
import gnome from 'eslint-config-gnome';

export default defineConfig([
    gnome.configs.recommended,
    {
        ignores: ['node_modules/', 'extras/'],
    },
    {
        files: ['kelpshell@aicheye/**/*.js'],
        languageOptions: {
            globals: {
                global: 'readonly',
            },
        },
        rules: {
            camelcase: ['error', {properties: 'never'}],
            'consistent-return': 'error',
            eqeqeq: ['error', 'smart'],
            'prefer-arrow-callback': 'error',
            'prefer-const': ['error', {destructuring: 'all'}],
        },
    },
]);
