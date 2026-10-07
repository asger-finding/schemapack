export const schema = {
  "asdf": [ 
    "string", 
    "varuint", 
    { "nesty": { "deep": "varuint" } }
  ]
};

export const items = [{
  "asdf": [
    "hello",
    5000,
    { "nesty": { "deep": 55 } },
    { "nesty": { "deep": 4 } }
  ]
}];
