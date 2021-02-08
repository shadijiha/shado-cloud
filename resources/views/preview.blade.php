@extends('layouts.index')

@section('scripts')
    <script>
        const file = {!! json_encode($file) !!};
    </script>
    <script>
        String.prototype.replaceSyntax = function (arr, color) {
            const regex = regexFromArray(arr);
            return this.replaceAll(regex, `<span style="color: ${color};">$&</span>`);
        }

        function syntaxHighligh() {
            let text = document.querySelector("#file_content pre").innerText;

            let keywords = ["import", "for", "var", "let", "const", "while", "function", "def", "with", "if", "else", "elif",
                "in", "of", "return", "class"];
            text = text.replaceSyntax(keywords, "purple");

            document.querySelector("#file_content pre").innerHTML = text;
        }

        function regexFromArray(arr) {
            let str = "";
            for (const temp of arr)
                str += temp + "|";

            return new RegExp("\\b(" + str + ")\\b", "gi");
        }


        // setInterval(function () {
        //     syntaxHighligh();
        // }, 1000);
    </script>
@endsection

@section('content')
    <div id="file_preview_dashboard"></div>
    <div id="file_content" contenteditable="true">
        <pre>{{ file_get_contents($file->getNative()->getPathname())  }}</pre>
    </div>
    <br/>
    <div id="debugDiv"></div>
    <script>
        const SAVE_INTERVAL = 5;    // Seconds
        let lastSavedContent = "";
        let autoSaver = setInterval(function () {
            // Check if content has changed and auto save is enabled, then save
            if (document.getElementById("file_content").innerText !== lastSavedContent && document.getElementById("auto_save").checked)
                SaveFile();
            else
                document.getElementById("status").innerText = "Nothing to save";
        }, SAVE_INTERVAL * 1000);

        async function SaveFile() {

            document.getElementById("status").innerHTML = "Saving...";

            const data = {
                path: "{{str_replace("\\", "\\\\", $file->getNative()->getRealPath())}}",
                data: document.getElementById("file_content").innerText
            };

            const response = await fetch('{{route("save")}}', {
                method: "POST",
                body: JSON.stringify(data),
                headers: {
                    'X-CSRF-TOKEN': '{{csrf_token()}}',
                    "content-Type": "application/json",
                }
            });

            const json = await response.json();

            // If Success
            if (json.status == {{ App\Http\Controllers\SaveController::SUCESSFUL_SAVE }}) {
                document.getElementById("status").innerHTML = "Saved!";
            } else {
                document.getElementById("status").innerHTML = "Error! " + json.message;
            }

            lastSavedContent = data.content;
        }

        // Add the Ctrl + S shortcut
        function DetectKeyStrocks(e) {
            //event.preventDefault();
            map[e.keyCode] = e.type == 'keydown';
            if (map[17] && map[83]) {
                e.preventDefault();
                // Check if content has changed
                if (document.getElementById("file_content").innerText !== lastSavedContent)
                    SaveFile();
                else
                    document.getElementById("status").innerText = "Nothing to save";
            }
        }

        let map = [];
        window.addEventListener("keydown", function (event) {
            DetectKeyStrocks(event);
        });
        window.addEventListener("keyup", function (event) {
            DetectKeyStrocks(event);
        });
    </script>
@endsection
