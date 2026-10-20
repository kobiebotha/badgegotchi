"""Narrow adaptation for SQLite 3.54.1's incomplete SQLITE_OMIT_WSD coverage."""
from pathlib import Path
import hashlib,re,json
root=Path(__file__).resolve().parent
source=Path('/Users/kobie/projects/powersync/skunkworks/powerbadge/native/sqlite-hello/vendor/sqlite-littlefs-vfs/vendor/sqlite/sqlite3.c')
expected_sha256='0c657666d819f261cc4007526ad57e1669de9949df7a8ea847aa284a2bf0ee52'
if hashlib.sha256(source.read_bytes()).hexdigest()!=expected_sha256:
    raise ValueError('SQLite source does not match the qualified pinned amalgamation')
s=source.read_text()
changes=[]
def change(a,b,count=1):
    global s
    actual=s.count(a)
    if actual!=count:raise ValueError((a,actual,count))
    s=s.replace(a,b);changes.append({'before':a,'after':b,'count':count})
for name in ['aDateTimeFuncs','aAlterTableFuncs','aBuiltinFunc','aWindowFuncs','aJsonFunc']:
    change('static FuncDef '+name+'[]','static const FuncDef '+name+'[]')
    change('sqlite3InsertBuiltinFuncs('+name+', ArraySize('+name+'));', 'sqlite3InsertBuiltinFuncs((FuncDef*)sqlite3_wsd_find((void*)'+name+', sizeof('+name+')), ArraySize('+name+'));')
# True globals are non-static so ARM accesses them via the GOT, which the loader supports.
change('SQLITE_PRIVATE FuncDefHash sqlite3BuiltinFunctions;', 'FuncDefHash sqlite3BuiltinFunctions;',2)
change('SQLITE_PRIVATE u32 sqlite3TreeTrace;', 'u32 sqlite3TreeTrace;')
change('SQLITE_PRIVATE u32 sqlite3TreeTrace = 0;', 'u32 sqlite3TreeTrace = 0;')
change('SQLITE_PRIVATE u32 sqlite3WhereTrace;', 'u32 sqlite3WhereTrace;')
change('SQLITE_PRIVATE u32 sqlite3WhereTrace = 0;', 'u32 sqlite3WhereTrace = 0;')
change('SQLITE_PRIVATE const char *sqlite3StdType[]', 'SQLITE_PRIVATE const char *const sqlite3StdType[]',2)
change('static struct OpenMode aCacheMode[]', 'static const struct OpenMode aCacheMode[]')
change('static struct OpenMode aOpenMode[]', 'static const struct OpenMode aOpenMode[]')
change('static sqlite3_module jsonEachModule', 'static const sqlite3_module jsonEachModule')
change('static HashElem nullElement = { 0, 0, 0, 0, 0 };','static const HashElem nullElement = { 0, 0, 0, 0, 0 };')
change('return &nullElement;', 'return (HashElem*)&nullElement;')
change('static VdbeOp dummy;', 'static const VdbeOp dummy;')
change('static u8 fakeCursor = CURSOR_VALID;', 'static const u8 fakeCursor = CURSOR_VALID;')
# JSON's zero placeholder is read-only; preserve the API's historically mutable pointer type.
change('static u8 aNull[] = { 0x00 };','static const u8 aNull[] = { 0x00 };')
change('pParse->aBlob = aNull;', 'pParse->aBlob = (u8*)aNull;')
change('db->init.azInit = sqlite3StdType;', 'db->init.azInit = (const char**)sqlite3StdType;',2)
change('aMode = aCacheMode;', 'aMode = (struct OpenMode*)aCacheMode;')
change('aMode = aOpenMode;', 'aMode = (struct OpenMode*)aOpenMode;')
# Read-only local initializer templates otherwise land in anonymous GCC .data.
for name in ('azOpt', 'azAff', 'azMsg', 'azOrigin'):
    change('const char *'+name+'[] =', 'static const char *const '+name+'[] =')
change('      struct WindowUpdate {', '      static const struct WindowUpdate {')
change('Token tOld = { "old", 3 };', 'static const Token tOld = { "old", 3 };')
change('Token tNew = { "new", 3 };', 'static const Token tNew = { "new", 3 };')
(root/'sqlite3-adapted.inc').write_text(s)
(root/'source-adaptations.json').write_text(json.dumps({'source':str(source),'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'adapted_sha256':hashlib.sha256(s.encode()).hexdigest(),'changes':changes},indent=2)+'\n')
