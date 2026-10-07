var fs = require('fs');
var test = require('ava');
var sp = require('./schemapack.js');

const fixtures = fs.readdirSync('./fixtures');

fixtures.forEach(file => {
  test(file, t => {
    const { schema, items } = require(`./fixtures/${file}`);
    const built = sp.build(schema);

    items.forEach(item => {
      const processed = built.decode(built.encode(item));
      t.deepEqual(processed, item);
    });
  })
});

test('rejects a declared array length larger than the buffer', t => {
  const built = sp.build({ reporters: ['string'] });
  const hostile = Buffer.from([0xFF, 0xFF, 0xFF, 0x7F]);
  t.throws(() => built.decode(hostile), { instanceOf: RangeError });
});

test('still decodes a valid array', t => {
  const built = sp.build({ reporters: ['string'] });
  const value = { reporters: ['1', '2', '3'] };
  t.deepEqual(built.decode(built.encode(value)), value);
});
