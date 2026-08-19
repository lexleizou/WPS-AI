Option Explicit

Dim shell, args, command, i
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments

If args.Count < 1 Then
  WScript.Quit 2
End If

command = QuoteArg(args(0))
For i = 1 To args.Count - 1
  command = command & " " & QuoteArg(args(i))
Next

shell.Run command, 0, True
WScript.Quit 0

Function QuoteArg(value)
  Dim text
  text = CStr(value)
  text = Replace(text, """", "\""")
  QuoteArg = """" & text & """"
End Function
