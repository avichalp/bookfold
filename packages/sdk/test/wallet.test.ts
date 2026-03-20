import assert from 'node:assert/strict';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createTempoWallet,
  formatWalletFundingMessage,
  InvalidTempoWalletError,
  resetWalletRuntimeForTests,
  resolveTempoPrivateKey,
  resolveTempoWallet,
  setWalletRuntimeForTests
} from '../src/wallet.js';

async function withTempoPrivateKey<T>(
  value: string | undefined,
  callback: () => Promise<T> | T
): Promise<T> {
  const previous = process.env.TEMPO_PRIVATE_KEY;
  if (value === undefined) {
    delete process.env.TEMPO_PRIVATE_KEY;
  } else {
    process.env.TEMPO_PRIVATE_KEY = value;
  }

  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.TEMPO_PRIVATE_KEY;
    } else {
      process.env.TEMPO_PRIVATE_KEY = previous;
    }
  }
}

test('resolveTempoWallet uses TEMPO_PRIVATE_KEY when set', async () => {
  await withTempoPrivateKey(
    '0x1111111111111111111111111111111111111111111111111111111111111111',
    () => {
      const resolved = resolveTempoWallet();

      assert.equal(resolved?.source, 'env');
      assert.equal(resolved?.accountName, 'TEMPO_PRIVATE_KEY');
      assert.equal(resolved?.serviceName, 'env');
    }
  );
});

test('resolveTempoPrivateKey rejects malformed values', async () => {
  await withTempoPrivateKey('bad-key', () => {
    assert.throws(
      () => resolveTempoPrivateKey(),
      /32-byte hex/
    );
  });
});

test('formatWalletFundingMessage includes the wallet address', () => {
  assert.match(
    formatWalletFundingMessage('0x5555555555555555555555555555555555555555'),
    /0x5555555555555555555555555555555555555555/
  );
});

test('resolveTempoWallet reports invalid Bookfold secure-store entries', async (t) => {
  await withTempoPrivateKey(undefined, () => {
    t.after(() => resetWalletRuntimeForTests());
    setWalletRuntimeForTests({
      platform: () => 'darwin',
      execFileSync: (_file, args) => {
        if (args[0] === 'find-generic-password') {
          return 'not-a-private-key';
        }

        throw new Error(`Unexpected command: ${args[0]}`);
      }
    });

    assert.throws(() => resolveTempoWallet(), (error) => {
      assert.ok(error instanceof InvalidTempoWalletError);
      assert.equal(error.source, 'app');
      assert.match(error.message, /wallet init --force/);
      return true;
    });
  });
});

test('createTempoWallet stores the generated private key via stdin on macOS', async (t) => {
  await withTempoPrivateKey(undefined, () => {
    let storedArgs: string[] | undefined;
    let storedOptions: unknown;

    t.after(() => resetWalletRuntimeForTests());
    setWalletRuntimeForTests({
      platform: () => 'darwin',
      execFileSync: (_file, args, options) => {
        if (args[0] === 'find-generic-password') {
          return '';
        }

        if (args[0] === '-i') {
          storedArgs = [...args];
          storedOptions = options;
          return '';
        }

        throw new Error(`Unexpected command: ${args[0]}`);
      }
    });

    const wallet = createTempoWallet();
    const inputValue =
      storedOptions && typeof storedOptions === 'object' && 'input' in storedOptions
        ? storedOptions.input
        : undefined;

    assert.deepEqual(storedArgs, ['-i', '-q']);
    assert.equal(typeof inputValue, 'string');
    const storedPrivateKeyMatch = /^add-generic-password -a 'default' -s 'bookfold' -U -w '(0x[0-9a-fA-F]{64})'\n$/.exec(
      inputValue as string
    );
    assert.ok(storedPrivateKeyMatch);
    const storedPrivateKey = storedPrivateKeyMatch[1] as `0x${string}`;
    assert.equal(
      wallet.address,
      privateKeyToAccount(storedPrivateKey).address
    );
    assert.equal(storedArgs?.includes(storedPrivateKey), false);
  });
});

test('createTempoWallet replaces invalid Bookfold secure-store entries', async (t) => {
  await withTempoPrivateKey(undefined, () => {
    let addCalls = 0;

    t.after(() => resetWalletRuntimeForTests());
    setWalletRuntimeForTests({
      platform: () => 'darwin',
      execFileSync: (_file, args) => {
        if (args[0] === 'find-generic-password') {
          return 'not-a-private-key';
        }

        if (args[0] === '-i') {
          addCalls += 1;
          return '';
        }

        throw new Error(`Unexpected command: ${args[0]}`);
      }
    });

    const wallet = createTempoWallet();

    assert.equal(addCalls, 1);
    assert.match(wallet.address, /^0x[0-9a-fA-F]{40}$/);
  });
});

test('createTempoWallet creates a macOS wallet that resolveTempoWallet can load again', async (t) => {
  await withTempoPrivateKey(undefined, () => {
    let storedSecret: string | undefined;

    t.after(() => resetWalletRuntimeForTests());
    setWalletRuntimeForTests({
      platform: () => 'darwin',
      execFileSync: (_file, args, options) => {
        if (args[0] === 'find-generic-password') {
          return storedSecret ?? '';
        }

        if (args[0] === '-i') {
          const inputValue =
            options && typeof options === 'object' && 'input' in options ? options.input : undefined;
          assert.equal(typeof inputValue, 'string');
          const match = /^add-generic-password -a 'default' -s 'bookfold' -U -w '(0x[0-9a-fA-F]{64})'\n$/.exec(
            inputValue as string
          );
          assert.ok(match);
          storedSecret = match[1];
          return '';
        }

        throw new Error(`Unexpected command: ${args[0]}`);
      }
    });

    const created = createTempoWallet();
    const resolved = resolveTempoWallet();

    assert.equal(resolved?.source, 'app');
    assert.equal(resolved?.address, created.address);
  });
});
