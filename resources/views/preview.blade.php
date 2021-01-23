@extends('layouts.index')

@section('content')
    <div id="file_preview_dashboard"></div>
    <div id="file_content" contenteditable="true">
        @foreach(file($file->getPathname()) as $line)
            {{$line}}
            <br/>
        @endforeach
    </div>


    <script defer>
        async function SaveFile() {
            const data = {
                path: "{{str_replace("\\", "\\\\", $file->getRealPath())}}",
                content: document.getElementById("file_content").innerText
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
        }

        // Set and unset auto save
        window.onload = function () {
            const CHECK_BOX = document.getElementById("auto_save");
            CHECK_BOX.onchange = function () {
                if (CHECK_BOX.checked) {
                    document.getElementById("file_content").onkeyup = SaveFile;
                } else {
                    document.getElementById("file_content").onkeyup = function () {
                    }
                }
            }

            CHECK_BOX.click();
        }
    </script>
@endsection
