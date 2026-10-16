"""生成済みテンプレートの書式を使って、SQLiteからExcelを再構築する。"""
from copy import deepcopy
from datetime import date
from pathlib import Path
import os
import zipfile
import xml.etree.ElementTree as ET

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
Q = lambda name: '{' + NS + '}' + name


def export(store):
    source = Path(__file__).parent / 'templates' / 'ledger.xlsx'
    target = store.directory / '会計ファイル.xlsx'
    temporary = target.with_suffix('.tmp')
    records = store.ledger()
    with zipfile.ZipFile(source) as original:
        xml = ET.fromstring(original.read('xl/worksheets/sheet1.xml'))
        data = xml.find(Q('sheetData'))
        styles = {}
        prototype = None
        for row in list(data):
            number = int(row.get('r'))
            if number == 9:
                prototype = deepcopy(row)
                styles = {''.join(filter(str.isalpha, c.get('r'))): c.get('s') for c in row}
            if number >= 7:
                data.remove(row)

        def cell(row, col, value=None, formula=None):
            c = ET.SubElement(row, Q('c'), {'r': f'{col}{row.get("r")}'})
            if styles.get(col) is not None:
                c.set('s', styles[col])
            if formula:
                ET.SubElement(c, Q('f')).text = formula
                ET.SubElement(c, Q('v')).text = str(value)
            elif isinstance(value, str):
                c.set('t', 'inlineStr')
                ET.SubElement(ET.SubElement(c, Q('is')), Q('t')).text = value
            elif value is not None:
                ET.SubElement(c, Q('v')).text = str(value)

        balance = 0
        total_income = total_expense = 0
        for index in range(max(len(records), 37)):
            r = index + 7
            row = ET.SubElement(data, Q('row'), {'r': str(r), 'ht': '28', 'customHeight': '1'})
            if index < len(records):
                day, category, income, expense = records[index]
                balance += income - expense
                total_income += income
                total_expense += expense
                serial = (date.fromisoformat(day) - date(1899, 12, 30)).days
                for col, value in zip('ABCDE', [index + 1, serial, category, income or None, expense or None]):
                    cell(row, col, value)
                cell(row, 'F', balance, ('D7-E7' if r == 7 else f'F{r-1}+D{r}-E{r}'))
            else:
                for col in 'ABCDEF':
                    cell(row, col)
            cell(row, 'G')
            cell(row, 'H')
        last = max(len(records), 37) + 6
        total_row = last + 1
        row = ET.SubElement(data, Q('row'), {'r': str(total_row)})
        cell(row, 'B', '合計')
        cell(row, 'D', total_income, f'SUM(D7:D{last})')
        cell(row, 'E', total_expense, f'SUM(E7:E{last})')
        cell(row, 'F', balance, f'D{total_row}-E{total_row}')
        # ヘッダー以外の結合を除く。取引件数の増加時も合計行が重ならない。
        merged = xml.find(Q('mergeCells'))
        if merged is not None:
            for entry in list(merged):
                ref = entry.get('ref')
                if int(''.join(filter(str.isdigit, ref.split(':')[0]))) >= 7:
                    merged.remove(entry)
            merged.set('count', str(len(merged)))
        dimension = xml.find(Q('dimension'))
        if dimension is not None:
            dimension.set('ref', f'A1:H{total_row}')
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as out:
            for entry in original.infolist():
                if entry.filename == 'xl/calcChain.xml':
                    continue
                content = original.read(entry.filename)
                if entry.filename == 'xl/worksheets/sheet1.xml':
                    content = ET.tostring(xml, encoding='utf-8', xml_declaration=True)
                elif entry.filename == 'xl/workbook.xml':
                    book = ET.fromstring(content)
                    for name in book.findall('.//' + Q('definedName')):
                        if name.get('name') == '_xlnm.Print_Area':
                            name.text = f"'Sheet1'!$A$1:$H${total_row}"
                    content = ET.tostring(book, encoding='utf-8', xml_declaration=True)
                out.writestr(entry.filename, content)
    os.replace(temporary, target)
    return target
