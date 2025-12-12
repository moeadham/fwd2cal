import { getEncoding, Tiktoken } from "js-tiktoken";

const DEFAULT_TOKENIZER = "cl100k_base";
const enc: Tiktoken = getEncoding(DEFAULT_TOKENIZER);

const tokenHelper = {
  countTokens: (text: string): number => {
    return enc.encode(text).length;
  },
};

export default tokenHelper;
