@extends('layouts.index')

@section('content')

    <div class="container">
        <div class="row">
            {{-- Display folders --}}
            @if($files instanceof \App\Http\Controllers\DirectoryStruct)
                @foreach($files->children as $child)
                    <div class="col-md-8 p-3">
                        <div class="card" style="cursor: pointer;"
                             onclick="window.location.href = '{{url("/") . "?path=" . str_replace("\\", "\\\\", $child->path)}}';">
                            <div
                                class="card-header">{{$child->getRelativePath()}}</div>

                            <div class="card-body">
                                @if (session('status'))
                                    <div class="alert alert-success" role="alert">
                                        {{ session('status') }}
                                    </div>
                                @endif

                                @foreach($child->files as $file)
                                    {{ $file->name  }}
                                    <br/>
                                @endforeach
                            </div>
                        </div>
                    </div>
                @endforeach

                {{-- Display files --}}
                @foreach($files->files as $file)
                    <div class="col-md-8 p-3">
                        <div class="card" style="cursor: pointer;"
                             onclick="window.location.href = '{{url("/") . "?path=" . str_replace("\\", "\\\\", $file->path)}}';">
                            <div class="card-header">{{$file->getRelativePath()}}</div>

                            <div class="card-body">
                                @if(File::exists('images/icons/{{$file->extension}}.png'))
                                    <img src="images/icons/{{$file->extension}}.png" class="file_thumnail"/>
                                @else
                                    <img src="images/icons/file.png" class="file_thumnail"/>
                                @endif
                            </div>
                        </div>
                    </div>
                @endforeach
            @endif
        </div>
    </div>

@endsection
