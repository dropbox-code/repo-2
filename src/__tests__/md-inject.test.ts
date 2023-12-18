import injectMarkdown from '../md-inject'

import { exec as baseExec } from 'child_process'
import baseEnvCi from 'env-ci'
import baseFs from 'fs-extra'
import baseGlob from 'globby'

jest.mock('child_process')
const exec: jest.Mock = jest.mocked(baseExec)

jest.mock('env-ci')
const envCi: jest.Mock = jest.mocked(baseEnvCi)

const logger = Object.fromEntries(
  Object.entries(console).map(([consoleProperty, consolePropertyValue]) => [
    consoleProperty,
    typeof consolePropertyValue === 'function'
      ? jest.fn()
      : consolePropertyValue,
  ])
)
jest.mock('../Logger', () => ({
  __esModule: true,
  default: class {
    constructor() {
      return logger
    }
  },
}))

const glob: jest.Mock = jest.mocked(baseGlob)
jest.mock('globby')

const fs: {
  readFile: jest.Mock
  writeFile: jest.Mock
} = jest.mocked(baseFs)
jest.mock('fs-extra')

const originalProcessEnv = process.env

describe('Markdown injection', () => {
  beforeEach(async () => {
    exec.mockImplementation((...args) => {
      const cb = args.pop()
      const err: any = null
      const stdout = ''
      cb(err, stdout)
    })

    envCi.mockImplementation(() => ({
      isCi: false,
      isPr: false,
    }))

    jest.clearAllMocks()

    process.env = originalProcessEnv
  })

  it('warns and exits with no action on pull request', async () => {
    envCi.mockImplementation(() => ({
      isCi: true,
      isPr: true,
    }))

    await injectMarkdown()

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not run during pull')
    )
    // Exit code is not non-0
    expect([null, undefined, 0]).toContain(process.exitCode)
    expect(glob).not.toHaveBeenCalled()
  })

  it('does not warn / exit early in CI on non-PR builds', async () => {
    envCi.mockImplementation(() => ({
      isCi: true,
      isPr: false,
    }))

    await injectMarkdown()

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('not run during pull')
    )
    expect(glob).toHaveBeenCalled()
  })

  it('collects all in-repo markdown files', async () => {
    await injectMarkdown()

    expect(glob).toHaveBeenCalledWith(
      '**/*.md',
      expect.objectContaining({ gitignore: true })
    )
  })

  it('throws gracefully when an error occurs while reading the file', async () => {
    fs.readFile.mockRejectedValue('some error')
    glob.mockResolvedValue(['foo.md'])

    await injectMarkdown()

    expect(logger.error).toHaveBeenCalledWith('foo.md: Error reading file')
    expect(logger.error).toHaveBeenCalledWith('some error')
    expect(process.exitCode).toBe(1)
  })

  it('does nothing', async () => {
    glob.mockResolvedValue(['foo.md'])
    fs.readFile.mockResolvedValue('# Foo')

    await injectMarkdown()

    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('reads all files', async () => {
    glob.mockResolvedValue(['foo.md', 'bar.md', 'baz.md', 'qux.md'])
    fs.readFile.mockResolvedValue('# Foo')

    await injectMarkdown()

    expect(fs.readFile).toHaveBeenCalledWith('foo.md', { encoding: 'utf-8' })
    expect(fs.readFile).toHaveBeenCalledWith('bar.md', { encoding: 'utf-8' })
    expect(fs.readFile).toHaveBeenCalledWith('baz.md', { encoding: 'utf-8' })
    expect(fs.readFile).toHaveBeenCalledWith('qux.md', { encoding: 'utf-8' })
  })

  it('throws gracefully when the config is malformed', async () => {
    glob.mockResolvedValue(['foo.md'])
    fs.readFile.mockResolvedValue(
      '<!-- CODEBLOCK_START {foo: bar} --><!-- CODEBLOCK_END -->'
    )

    await injectMarkdown()

    expect(logger.error).toHaveBeenCalledWith(
      'Error parsing config:\n{foo: bar}'
    )
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(
          /Unexpected token|Expected property name/
        ),
      })
    )
    expect(process.exitCode).toBe(1)
  })

  it('throws if an invalid block type is passed', async () => {
    mock({
      config: {
        type: 'git',
      },
    })

    await injectMarkdown()

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Unexpected "type" of "git". Valid types are "command", "file"',
      })
    )
    expect(process.exitCode).toBe(1)
  })

  it('runs an arbitrary command', async () => {
    mock({
      config: {
        type: 'command',
        value: 'some arbitrary command',
      },
    })

    await injectMarkdown()

    expect(exec).toHaveBeenCalledWith(
      'some arbitrary command',
      expect.anything(), // config
      expect.anything() // callback
    )
  })

  it('imports a file', async () => {
    mock({
      mockFileName: 'foo.md',
      config: {
        type: 'file',
        value: 'bar.js',
      },
    })

    await injectMarkdown()

    expect(fs.readFile).toHaveBeenCalledWith('foo.md', { encoding: 'utf-8' })
    expect(fs.readFile).toHaveBeenCalledWith(
      expect.stringContaining('bar.js'),
      { encoding: 'utf-8' }
    )
  })

  it('defaults to file import type', async () => {
    mock({
      mockFileName: 'foo.md',
      config: {
        value: 'bar.js',
      },
    })

    await injectMarkdown()

    expect(fs.readFile).toHaveBeenCalledWith('foo.md', { encoding: 'utf-8' })
    expect(fs.readFile).toHaveBeenCalledWith(
      expect.stringContaining('bar.js'),
      { encoding: 'utf-8' }
    )
  })

  it.each([
    [
      `<!-- CODEBLOCK_START {"type": "command", "value": "some arbitrary command"} --><!-- CODEBLOCK_END -->`,
    ],
    [
      `<!-- CODEBLOCK_START {"type":"command","value":"some arbitrary command"} --><!-- CODEBLOCK_END -->`,
    ],
    [
      `
<!--
  CODEBLOCK_START
  {
    "type": "command",
    "value": "some arbitrary command"
  }
-->

<!--
  CODEBLOCK_END
-->
`,
    ],
    [
      `<!--CODEBLOCK_START {"type": "command", "value": "some arbitrary command"}--><!--CODEBLOCK_END-->`,
    ],
    [
      `<!--CODEBLOCK_START {"type": "command", "value": "some arbitrary command"} --><!--CODEBLOCK_END -->`,
    ],
    [
      `<!-- CODEBLOCK_START {"type": "command", "value": "some arbitrary command"}--><!-- CODEBLOCK_END-->`,
    ],
    [
      `<!-- CODEBLOCK_START {"type": "command", "value": "some arbitrary command"} --> <!-- CODEBLOCK_END -->`,
    ],
    [
      `<!-- CODEBLOCK_START {"type": "command", "value": "some arbitrary command"} -->Foo<!-- CODEBLOCK_END -->`,
    ],
    [
      `<!-- CODEBLOCK_START {"type": "command", "value": "some arbitrary command"} --> Foo <!-- CODEBLOCK_END -->`,
    ],
    [
      `<!-- CODEBLOCK_START {"type": "command", "value": "some arbitrary command"} -->
<!-- CODEBLOCK_END -->`,
    ],
    [
      `<!-- CODEBLOCK_START {"type": "command", "value": "some arbitrary command"} -->
Foo<!-- CODEBLOCK_END -->`,
    ],
    [
      `<!-- CODEBLOCK_START {"type": "command", "value": "some arbitrary command"} -->
Foo
<!-- CODEBLOCK_END -->`,
    ],
    [
      `<!-- CODEBLOCK_START {"type": "command", "value": "some arbitrary command"} -->
    Foo
  <!-- CODEBLOCK_END -->`,
    ],
    [
      `{/* CODEBLOCK_START {"type": "command", "value": "some arbitrary command"} */} Foo {/* CODEBLOCK_END */}`,
    ],
  ])('handles wonky formatting', async (markdownContent) => {
    glob.mockResolvedValue(['foo.md'])
    fs.readFile.mockResolvedValue(markdownContent)

    await injectMarkdown()

    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(
      'some arbitrary command',
      expect.anything(),
      expect.anything()
    )
  })

  it('writes to the markdown document (command)', async () => {
    mock({
      config: {
        type: 'command',
        value: 'some arbitrary command',
      },
      mockResponse: 'The output of some arbitrary command',
    })

    await injectMarkdown()

    const outFile = `
<!-- CODEBLOCK_START {"type":"command","value":"some arbitrary command"} -->
<!-- prettier-ignore -->
~~~~~~~~~~bash
$ some arbitrary command

The output of some arbitrary command
~~~~~~~~~~

<!-- CODEBLOCK_END -->`
    expect(fs.writeFile).toHaveBeenCalledWith('foo.md', outFile)
  })

  it('writes to the markdown document (command) with mdx syntax', async () => {
    mock({
      config: {
        type: 'command',
        value: 'some arbitrary command',
      },
      mockResponse: 'The output of some arbitrary command',
    })

    await injectMarkdown()

    const outFile = `
{/* CODEBLOCK_START {"type":"command","value":"some arbitrary command"} */}
{/* prettier-ignore */}
~~~~~~~~~~bash
$ some arbitrary command

The output of some arbitrary command
~~~~~~~~~~

{/* CODEBLOCK_END */}`
    expect(fs.writeFile).toHaveBeenCalledWith('foo.md', outFile)
  })

  it('does not write to the markdown document (command) because of bad syntax', async () => {
    const inFile = `
<!-- CODEBLOCK_START {"type":"command","value":"some arbitrary command"} */}

<!-- CODEBLOCK_END */}`

    const inFileName = `<!-- prettier-ignore -->
~~~~~~~~~~bash
$ some arbitrary command

The output of some arbitrary command
~~~~~~~~~~`

    glob.mockResolvedValue([inFileName])

    fs.readFile.mockImplementation(async (fileName) => {
      if (fileName === inFileName) {
        return inFile
      }
      throw new Error('Unexpected file name passed')
    })

    await injectMarkdown()

    expect(fs.readFile).toHaveBeenCalledWith(inFileName, { encoding: 'utf-8' })

    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('writes to the markdown document (file)', async () => {
    mock({
      config: {
        type: 'file',
        value: 'bar.js',
      },
      mockResponse: `console.log('baz')`,
    })

    await injectMarkdown()

    const outFile = `
<!-- CODEBLOCK_START {"type":"file","value":"bar.js"} -->
<!-- prettier-ignore -->
~~~~~~~~~~js
File: bar.js

console.log('baz')
~~~~~~~~~~

<!-- CODEBLOCK_END -->`
    expect(fs.writeFile).toHaveBeenCalledWith('foo.md', outFile)
  })

  it('trims whitespace (command)', async () => {
    mock({
      config: {
        type: 'command',
        value: 'some arbitrary command',
      },
      mockResponse: `


The output of some arbitrary command


`,
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.stringMatching(
        /[^\n]\n{2}The output of some arbitrary command\n[^\n]/
      )
    )
  })

  it('trims whitespace (file)', async () => {
    mock({
      config: {
        value: 'bar.js',
      },
      mockResponse: `



console.log('baz')





`,
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.stringMatching(/[^\n]\n{2}console\.log\('baz'\)\n{1}[^\n]/)
    )
  })

  it('can retain whitespace (command)', async () => {
    mock({
      config: {
        type: 'command',
        value: 'some arbitrary command',
        trim: false,
      },
      mockResponse: `


The output of some arbitrary command

`,
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.stringMatching(/\n{3,}The output of some arbitrary command\n{2,}/)
    )
  })

  it('can retain whitespace (file)', async () => {
    mock({
      config: {
        value: 'bar.js',
        trim: false,
      },
      mockResponse: `



console.log('baz')





`,
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.stringMatching(/\n{4,}console\.log\('baz'\)\n{6,}/)
    )
  })

  it('displays the input command', async () => {
    mock({
      config: {
        type: 'command',
        value: 'some arbitrary command',
      },
      mockResponse: 'some arbitrary stdout',
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.stringContaining('$ some arbitrary command')
    )
  })

  it('displays the input file', async () => {
    mock({
      config: {
        value: 'bar.js',
      },
      mockResponse:
        'Weight lifting. Lawyer regulatory board. Pole vaulter’s nemesis',
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.stringContaining('File: bar.js')
    )
  })

  it('can hide the input command', async () => {
    mock({
      config: {
        type: 'command',
        value: 'some arbitrary command',
        hideValue: true,
      },
      mockResponse: 'some arbitrary stdout',
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.not.stringContaining('$ some arbitrary command')
    )
  })

  it('can hide the input file', async () => {
    mock({
      config: {
        value: 'bar.js',
        hideValue: true,
      },
      mockResponse: 'Speakeasies',
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.not.stringMatching('File: bar.js')
    )
  })

  it('can select a language (file)', async () => {
    mock({
      config: {
        value: 'bar.js',
        language: 'coffeescript', // :shrug:
      },
      mockResponse: 'Coffee bar?',
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.stringMatching(/^~{10}coffeescript$/m)
    )
  })

  it('can select a language (command)', async () => {
    mock({
      config: {
        type: 'command',
        value: 'npm view react-scripts --json',
        language: 'json',
      },
      mockResponse: '{ "version": "17.x" }',
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.stringMatching(/^~{10}json$/m)
    )
  })

  it('language is inferred from file extension', async () => {
    mock({
      config: {
        value: 'bar.sh',
      },
      mockResponse: 'echo "bar"',
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.stringMatching(/^~{10}sh$/m)
    )
  })

  it('language defaults to bash when unspecified', async () => {
    mock({
      config: {
        type: 'command',
        value: 'some arbitrary command',
      },
      mockResponse: 'some arbitrary stdout',
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.stringMatching(/^~{10}bash$/m)
    )
  })

  it('language defaults to bash when it can not be inferred', async () => {
    mock({
      config: {
        value: 'shell-scripts/foo',
      },
      mockResponse: 'something',
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.stringMatching(/^~{10}bash$/m)
    )
  })

  it('writes over content that already exists', async () => {
    mock({
      config: {
        value: 'shell-scripts/foo',
      },
      blockContents: `~~~~~~~~~~bash
File: shell-scripts/foo

echo "Hello America"
~~~~~~~~~~
`,
      mockResponse: 'echo "Hello World"',
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.stringMatching('Hello World')
    )
  })

  it('does not perform a write if no change was made', async () => {
    mock({
      config: {
        value: 'shell-scripts/foo',
      },
      blockContents: `~~~~~~~~~~bash
File: shell-scripts/foo

echo "Hello World"
~~~~~~~~~~
`,
      mockResponse: 'echo "Hello World"',
    })

    await injectMarkdown()

    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('prevents prettier auto-formatting of code block and interior syntax', async () => {
    mock({
      config: {
        value: 'bar.js',
      },
      mockResponse: 'module.exports = () => console.log("5:00")',
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.stringMatching(/<!-- prettier-ignore -->\n~{10}/)
    )
  })

  it('can ignore a block', async () => {
    mock({
      name: '_IGNORE',
      config: {
        value: 'bar.js',
        ignore: true,
      },
    })

    await injectMarkdown()

    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('ignores nested blocks', async () => {
    mock({
      name: '_IGNORE',
      config: {
        value: 'bar.js',
        ignore: true,
      },
      blockContents: `~~~
      <!-- CODEBLOCK_START {"value": ".nvmrc"} -->

      <!-- CODEBLOCK_END -->
      ~~~`,
    })

    await injectMarkdown()

    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('supports block naming', async () => {
    mock({
      name: '_NAMED',
      config: {
        value: 'bar.js',
      },
      blockContents: `
      <!-- CODEBLOCK_END -->
      {/* CODEBLOCK_END */}
      <!-- CODEBLOCK_END -->
      <!-- CODEBLOCK_END -->
`,
      mockResponse: 'console.log("👋")',
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      `
<!-- CODEBLOCK_START_NAMED {"value":"bar.js"} -->
<!-- prettier-ignore -->
~~~~~~~~~~js
File: bar.js

console.log("👋")
~~~~~~~~~~

<!-- CODEBLOCK_END_NAMED -->`
    )
  })

  it('performs surgical replacement', async () => {
    glob.mockResolvedValue(['foo.md'])

    fs.readFile.mockImplementation(async (fileName) => {
      if (fileName === 'foo.md') {
        return `
<!-- CODEBLOCK_START_META {"ignore": true} -->
~~~
<!-- CODEBLOCK_START {"value": "bar.js"} -->
<!-- CODEBLOCK_END -->
~~~
<!-- CODEBLOCK_END_META -->

<!-- CODEBLOCK_START {"value": "bar.js"} -->
<!-- CODEBLOCK_END -->

<!-- CODEBLOCK_START_META_2 {"ignore": true} -->
~~~
<!-- CODEBLOCK_START {"value": "bar.js"} -->
<!-- CODEBLOCK_END -->
~~~
<!-- CODEBLOCK_END_META_2 -->

`
      }

      if (fileName.includes('bar.js')) {
        return "console.log('Hello World')"
      }

      throw new Error('Unexpected file name passed')
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      `
<!-- CODEBLOCK_START_META {"ignore": true} -->
~~~
<!-- CODEBLOCK_START {"value": "bar.js"} -->
<!-- CODEBLOCK_END -->
~~~
<!-- CODEBLOCK_END_META -->

<!-- CODEBLOCK_START {"value": "bar.js"} -->
<!-- prettier-ignore -->
~~~~~~~~~~js
File: bar.js

console.log('Hello World')
~~~~~~~~~~

<!-- CODEBLOCK_END -->

<!-- CODEBLOCK_START_META_2 {"ignore": true} -->
~~~
<!-- CODEBLOCK_START {"value": "bar.js"} -->
<!-- CODEBLOCK_END -->
~~~
<!-- CODEBLOCK_END_META_2 -->

`
    )
  })

  it('handles multiple blocks in one file', async () => {
    glob.mockResolvedValue(['foo.md'])
    fs.readFile.mockImplementation(
      async () => `
# Foo Package

<!--
  CODEBLOCK_START
  {
    "type": "command",
    "value": "npm view foo"
  }
-->
<!-- CODEBLOCK_END -->

{/*
  CODEBLOCK_START
  {
    "type": "command",
    "value": "npm view foo"
  }
*/}
{/* CODEBLOCK_END */}

# Bar Package

<!--
  CODEBLOCK_START
  {
    "type": "command",
    "value": "npm view bar"
  }
-->
<!-- CODEBLOCK_END -->`
    )
    exec.mockImplementation((cmd, env, cb) => {
      cb(null, `OUT: ${cmd}`)
    })

    await injectMarkdown()

    expect(fs.writeFile).toHaveBeenCalledWith(
      'foo.md',
      expect.stringMatching(/OUT: npm view foo(.|\n)*OUT: npm view bar/)
    )
  })

  it('removes color from commands', async () => {
    mock({
      config: {
        type: 'command',
        value: 'npm view react-scripts',
      },
    })

    await injectMarkdown()

    const [, execConfig] = exec.mock.calls[0]

    /*
      "expect(execConfig.env.FORCE_COLOR).toBe('0')" is purposefully surgical, as
      "expect(mock).toHaveBeenCalledWith(..., { env: expect.objectContaining({FORCE_COLOR: '0'}) }, ...)"
      will write all of process.env to the console if the assertion fails.
    */
    expect(execConfig.env.FORCE_COLOR).toBe('0')
  })

  it('passes configured environment to commands', async () => {
    mock({
      config: {
        type: 'command',
        value: 'npm view react-scripts',
        environment: {
          FOO_ENV: 'bar val',
        },
      },
    })

    await injectMarkdown()

    const [, execConfig] = exec.mock.calls[0]

    expect(execConfig.env.FOO_ENV).toBe('bar val')
  })

  it('passes system environment to commands', async () => {
    process.env.MY_SYS_ENV = 'a test'

    mock({
      config: {
        type: 'command',
        value: 'npm view react-scripts',
      },
    })

    await injectMarkdown()

    const [, execConfig] = exec.mock.calls[0]

    expect(exec).toHaveBeenCalledTimes(1)

    expect(execConfig.env.MY_SYS_ENV).toBe('a test')
  })

  it('can prevent system environment from being passed', async () => {
    process.env.MY_SYS_ENV = 'b test'

    mock({
      config: {
        type: 'command',
        value: 'npm view react-scripts',
      },
    })

    await injectMarkdown({
      blockPrefix: 'CODEBLOCK',
      followSymbolicLinks: true,
      globPattern: '**/*.md',
      quiet: false,
      useSystemEnvironment: false,
    })

    const [, execConfig] = exec.mock.calls[0]

    expect(exec).toHaveBeenCalledTimes(1)

    expect(execConfig.env.MY_SYS_ENV).not.toBeDefined()
  })

  it('can overwrite FORCE_COLOR', async () => {
    mock({
      config: {
        type: 'command',
        value: 'npm view react-scripts',
        environment: {
          FORCE_COLOR: 'true',
        },
      },
    })

    await injectMarkdown()

    const [, execConfig] = exec.mock.calls[0]

    expect(execConfig.env.FORCE_COLOR).toBe('true')
  })

  it('substitutes passed environment variables from system environment variables', async () => {
    process.env.MY_SYS_ENV = 'c test'
    mock({
      config: {
        type: 'command',
        value: 'npm view react-scripts',
        environment: {
          MY_PASSED_ENV: '$MY_SYS_ENV',
        },
      },
    })

    await injectMarkdown()

    const [, execConfig] = exec.mock.calls[0]

    expect(execConfig.env.MY_PASSED_ENV).toBe('c test')
  })

  it('overwrites system environment', async () => {
    process.env.MY_SYS_ENV = 'd test'
    mock({
      config: {
        type: 'command',
        value: 'npm view react-scripts',
        environment: {
          MY_SYS_ENV: 'e test',
        },
      },
    })

    await injectMarkdown()

    const [, execConfig] = exec.mock.calls[0]

    expect(execConfig.env.MY_SYS_ENV).toBe('e test')
  })

  it('throws if a file is empty (after trimming)', async () => {
    mock({
      config: {
        value: 'foo.md',
      },
      mockResponse: `
      
      
  `,
    })

    await injectMarkdown()

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('No content was returned'),
      })
    )
    expect(process.exitCode).toBe(1)
  })

  it('throws if a command returns no output (after trimming)', async () => {
    mock({
      config: {
        type: 'command',
        value: `echo ''`,
      },
      mockResponse: `
`,
    })

    await injectMarkdown()

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('No content was returned'),
      })
    )
    expect(process.exitCode).toBe(1)
  })
})

const mock = ({
  name = '',
  mockFileName = 'foo.md',
  config,
  includePrettierIgnore = true,
  blockContents = '',
  mockResponse = '',
}: {
  name?: string
  mockFileName?: string
  config: any
  includePrettierIgnore?: boolean
  blockContents?: string
  mockResponse?: string
}) => {
  glob.mockResolvedValue([mockFileName])

  fs.readFile.mockImplementation(async (fileName) => {
    if (fileName === mockFileName) {
      return `
<!-- CODEBLOCK_START${name} ${JSON.stringify(config)} -->
${includePrettierIgnore ? '<!-- prettier-ignore -->\n' : ''}${blockContents}
<!-- CODEBLOCK_END${name} -->`
    }

    if (config.type !== 'command' && fileName.includes(config.value)) {
      return mockResponse
    }
    throw new Error('Unexpected file name passed')
  })

  if (config.type === 'command') {
    exec.mockImplementation((...args) => {
      const cb = args.pop()
      cb(null, mockResponse)
    })
  }
}
