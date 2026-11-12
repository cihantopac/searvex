import { describe, expect, it } from 'vitest';
import { astroPageMeta, bladeHasTitle, bladeMarkup, scriptHeadMeta, vuePageMeta } from '../../src/repo/sfc.js';

describe('G5: Vue SFC', () => {
  it('reads useHead / useSeoMeta / definePageMeta arguments', () => {
    expect(vuePageMeta(`<script setup lang="ts">\nuseSeoMeta({ title: 'Pricing', description: 'Plans and prices', robots: 'noindex, follow' })\n</script><template><main/></template>`)).toEqual({ hasTitle: true, hasDescription: true, noindex: true });
    expect(vuePageMeta(`<script setup>\nuseHead({ titleTemplate: '%s · Acme', meta: [{ name: 'description', content: 'x' }] })\n</script>`)).toEqual({ hasTitle: true, hasDescription: true, noindex: false });
    expect(vuePageMeta(`<script setup>\ndefinePageMeta({ title: 'About' })\n</script>`).hasTitle).toBe(true);
  });

  it('does not count head calls in comments or strings (the regex did)', () => {
    const src = `<script setup>\n// useHead({ title: 'old' })\nconst help = 'call useSeoMeta to set a title'\n</script><template><p>{{ help }}</p></template>`;
    expect(vuePageMeta(src)).toEqual({ hasTitle: false, hasDescription: false, noindex: false });
  });

  it('a computed argument is unknown, not missing', () => {
    expect(vuePageMeta(`<script setup>\nconst seo = computed(() => ({ title: post.value.title }))\nuseHead(seo)\n</script>`).hasTitle).toBeNull();
  });

  it('Nuxt <Title> and <Meta> components in the template', () => {
    expect(vuePageMeta(`<template><Head><Title>Docs</Title><Meta name="description" content="x" /></Head></template>`)).toMatchObject({ hasTitle: true, hasDescription: true });
  });

  it('counts calls in scripts', () => {
    expect(scriptHeadMeta(`useHead({ title: 'a' }); useSeoMeta({ description: 'b' })`, 'x.ts').calls).toBe(2);
  });
});

describe('G5: Astro', () => {
  const layout = (attrs: string, body = '') => `---\nimport Layout from '../layouts/Base.astro';\nconst posts = await getCollection('blog');\n---\n<Layout ${attrs}>\n<main>${body}</main>\n</Layout>`;

  it('a title prop on a component counts; an HTML title attribute does not (the regex counted it)', () => {
    expect(astroPageMeta(layout('title="Home" description="Welcome"'), 'src/pages/index.astro')).toEqual({ hasTitle: true, hasDescription: true, noindex: false });
    expect(astroPageMeta(layout('', '<a href="/x" title="More">More</a><img src="/a.png" title="A">'), 'src/pages/x.astro').hasTitle).toBe(false);
    expect(astroPageMeta(layout('title={post.data.title}'), 'src/pages/p.astro').hasTitle).toBe(true);
  });

  it('a spread into the layout is unknown; <title>, meta robots and a noindex prop are read', () => {
    expect(astroPageMeta(layout('{...post.data}'), 'src/pages/blog/[slug].astro').hasTitle).toBeNull();
    expect(astroPageMeta(`---\n---\n<html><head><title>T</title><meta name="robots" content="noindex"></head></html>`, 'src/pages/t.astro')).toEqual({ hasTitle: true, hasDescription: false, noindex: true });
    expect(astroPageMeta(layout('title="X" noindex'), 'src/pages/n.astro').noindex).toBe(true);
  });

  it('Markdown pages read their YAML frontmatter', () => {
    expect(astroPageMeta(`---\ntitle: Notes\ndescription: Field notes\n---\n# Notes`, 'src/pages/notes.md')).toEqual({ hasTitle: true, hasDescription: true, noindex: false });
    expect(astroPageMeta(`---\nlayout: ../layouts/Base.astro\n---\n# Untitled`, 'src/pages/u.md').hasTitle).toBe(false);
  });
});

describe('G5: Blade', () => {
  it('ignores Blade comments, @verbatim and @php blocks', () => {
    expect(bladeHasTitle(`<head>{{-- <title>Old</title> --}}</head>`)).toBe(false);
    expect(bladeHasTitle(`<head>@verbatim <title>{{ raw }}</title> @endverbatim</head>`)).toBe(false);
    expect(bladeHasTitle(`<head><title>@yield('title', config('app.name'))</title></head>`)).toBe(true);
    expect(bladeMarkup(`a @php echo '<title>'; @endphp b`)).toBe('a  b');
  });
});
