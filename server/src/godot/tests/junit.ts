import { XMLParser } from 'fast-xml-parser';

export type TestStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface TestCase {
  suite: string;
  name: string;
  status: TestStatus;
  /** Failure/error/skip text, whitespace-normalized. */
  message: string | undefined;
  /** Best-effort source location of the failure. */
  file: string | undefined;
  line: number | undefined;
  /** Seconds. */
  time: number;
}

export interface TestSuite {
  name: string;
  /** Test count the suite declares; can exceed `cases.length` when tests crash or are skipped silently. */
  declared: number;
  cases: TestCase[];
}

/** Matches `res://path/file.gd:12` (gdUnit4 messages). */
const RES_LOCATION = /(res:\/\/[^\s:'"]+\.gd):(\d+)/;
/** Matches `at line 12` (GUT messages; -1 when unknown). */
const AT_LINE = /at line (-?\d+)/;
const RES_PREFIX = 'res://';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  cdataPropName: '#cdata',
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) => ['testsuite', 'testcase', 'failure', 'error', 'skipped'].includes(name),
});

type XmlNode = Record<string, unknown>;

/** Parses JUnit XML as written by GUT (-gjunit_xml_file) and gdUnit4 (results.xml). */
export function parseJUnit(xml: string): TestSuite[] {
  const doc = parser.parse(xml) as XmlNode;
  const root = (doc.testsuites ?? doc) as XmlNode;
  return nodes(root.testsuite).map(toSuite);
}

function toSuite(node: XmlNode): TestSuite {
  const name = str(node.name);
  const cases = nodes(node.testcase).map((c) => toCase(c, name));
  return { name, declared: Number(str(node.tests) || cases.length), cases };
}

function toCase(node: XmlNode, suite: string): TestCase {
  const [status, detail] = outcome(node);
  const message = detail === undefined ? undefined : normalize(detail);
  const location = locate(detail ?? '', str(node.classname));
  return {
    suite,
    name: str(node.name),
    status,
    message: message === '' ? undefined : message,
    file: location.file,
    line: location.line,
    time: Number(str(node.time) || 0),
  };
}

function outcome(node: XmlNode): [TestStatus, string | undefined] {
  const error = nodes(node.error)[0];
  if (error !== undefined) return ['error', detailText(error)];
  const failure = nodes(node.failure)[0];
  if (failure !== undefined) return ['failed', detailText(failure)];
  const skipped = nodes(node.skipped)[0];
  if (skipped !== undefined) return ['skipped', detailText(skipped)];
  return ['passed', undefined];
}

/** Body text (CDATA or plain), falling back to the `message` attribute. */
function detailText(node: XmlNode): string {
  const body = [node['#cdata'], node['#text']]
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  return body.trim() === '' ? str(node.message) : body;
}

function locate(
  detail: string,
  classname: string,
): { file: string | undefined; line: number | undefined } {
  const res = RES_LOCATION.exec(detail);
  if (res !== null) return { file: res[1], line: Number(res[2]) };
  // GUT: classname is the test script path without res://, and the message says "at line N".
  const file = classname.endsWith('.gd')
    ? `${RES_PREFIX}${classname.replace(/^res:\/\//, '')}`
    : undefined;
  const at = AT_LINE.exec(detail);
  const line = at === null || Number(at[1]) < 0 ? undefined : Number(at[1]);
  return { file, line };
}

/** Collapses whitespace and drops boilerplate so failures read as one compact line. */
function normalize(text: string): string {
  return text
    .replace(/Godot Runtime Error !/g, '')
    .replace(/\s*at (line -?\d+|'[^']*' in res:\/\/\S+)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nodes(value: unknown): XmlNode[] {
  return Array.isArray(value) ? (value as XmlNode[]) : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
