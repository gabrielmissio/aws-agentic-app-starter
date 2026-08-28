import { describe, expect, it } from 'vitest'
import { normalizeMarkdown, splitStreamingMarkdown } from '../lib/markdown'

describe('normalizeMarkdown', () => {
  it('rebuilds a table the model flattened onto one line', () => {
    const flattened =
      'Agora vou montar o carrinho.| Campo | Valor | |---|---| | Merchant | TastyGo | | **Total** | R$ 453,50 |'

    expect(normalizeMarkdown(flattened)).toBe(
      [
        'Agora vou montar o carrinho.',
        '',
        '| Campo | Valor |',
        '| --- | --- |',
        '| Merchant | TastyGo |',
        '| **Total** | R$ 453,50 |',
      ].join('\n'),
    )
  })

  it('rebuilds rows that were glued with no space between them', () => {
    expect(normalizeMarkdown('| a | b ||---|---|| c | d |')).toBe(
      ['| a | b |', '| --- | --- |', '| c | d |'].join('\n'),
    )
  })

  it('keeps a row that carries fewer cells than the header declares', () => {
    // GFM pads a short row; the point is that it stays a row rather than being merged into the next.
    expect(normalizeMarkdown('| a | b | c | |---|---|---| | only |')).toBe(
      ['| a | b | c |', '| --- | --- | --- |', '| only |'].join('\n'),
    )
  })

  it('leaves a correctly formatted table alone', () => {
    const table = ['| Campo | Valor |', '|---|---|', '| Merchant | TastyGo |'].join('\n')
    expect(normalizeMarkdown(table)).toBe(table)
  })

  it('leaves prose containing a pipe alone', () => {
    const prose = 'Use grep | wc -l to count matches — no table here.'
    expect(normalizeMarkdown(prose)).toBe(prose)
  })

  it('never rewrites inside a fenced code block', () => {
    const fenced = ['```md', '| a | b | |---|---| | c | d |', '```', 'depois'].join('\n')
    expect(normalizeMarkdown(fenced)).toBe(fenced)
  })

  it('closes a fence the stream has not closed yet', () => {
    expect(normalizeMarkdown('```ts\nconst a = 1')).toBe('```ts\nconst a = 1\n```')
  })

  it('closes only with a fence of the same kind and length', () => {
    expect(normalizeMarkdown('~~~~\ncode')).toBe('~~~~\ncode\n~~~~')
  })

  it('opens a blank line before a table the model ran on from its own prose', () => {
    // GFM will not let a table interrupt a paragraph, so without the break the header row is read
    // as more prose and the table never forms.
    const out = normalizeMarkdown('Seu carrinho:\n| Item | Preco |\n|---|---|\n| Pizza | R$ 45 |')
    expect(out.split('\n')[1]).toBe('')
    expect(out).toContain('Seu carrinho:\n\n| Item | Preco |')
  })

  it('leaves an already separated table alone', () => {
    const md = 'Seu carrinho:\n\n| Item | Preco |\n|---|---|\n| Pizza | R$ 45 |'
    expect(normalizeMarkdown(md)).toBe(md)
  })

  it('does not open a break between a table and its own rows', () => {
    const md = '| Item | Preco |\n|---|---|\n| Pizza | R$ 45 |'
    expect(normalizeMarkdown(md)).toBe(md)
  })

  it('does not mistake a line of dashes for a delimiter row', () => {
    const md = 'Resumo:\n---\nO pedido saiu.'
    expect(normalizeMarkdown(md)).toBe(md)
  })

  it('is a no-op for ordinary prose', () => {
    const text = 'Primeiro parágrafo.\n\nSegundo parágrafo com **negrito**.'
    expect(normalizeMarkdown(text)).toBe(text)
  })
})

describe('splitStreamingMarkdown', () => {
  it('parses every complete line and holds back the one still being written', () => {
    const { complete, tail } = splitStreamingMarkdown('| a | b |\n|---|---|\n| c | par')
    expect(complete).toBe('| a | b |\n|---|---|')
    expect(tail).toBe('| c | par')
  })

  it('holds everything back until the first line break', () => {
    expect(splitStreamingMarkdown('Ainda escrevendo')).toEqual({
      complete: '',
      tail: 'Ainda escrevendo',
    })
  })

  it('renders a table the model is flattening as its rows arrive', () => {
    // Once the delimiter row is there, the rest of the line is table rows, not prose.
    const { complete, tail } = splitStreamingMarkdown(
      'Vou montar o carrinho.| Campo | Valor | |---|---| | Merchant | Tasty',
    )
    expect(complete).toBe(
      ['Vou montar o carrinho.', '', '| Campo | Valor |', '| --- | --- |', '| Merchant | Tasty |'].join('\n'),
    )
    expect(tail).toBe('')
  })

  it('still holds back a partial row before the delimiter arrives', () => {
    expect(splitStreamingMarkdown('Vou montar o carrinho.| Campo | Val')).toEqual({
      complete: '',
      tail: 'Vou montar o carrinho.| Campo | Val',
    })
  })

  it('normalizes what it hands to the parser', () => {
    const { complete } = splitStreamingMarkdown('| a | b | |---|---| | c | d |\n')
    expect(complete).toBe(['| a | b |', '| --- | --- |', '| c | d |'].join('\n'))
  })
})
